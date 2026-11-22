import { existsSync, readFileSync } from "node:fs";
if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* ignore */ } }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { Ledger } from "../ledger/ledger.js";
import { runPipeline } from "../runner/pipeline.js";
import { buildPipeline } from "../pipeline.js";
import { RequestSchema } from "../core/types.js";
import { emit, subscribe, history } from "./events.js";
import { executeApproved } from "../actions/execute.js";

/**
 * TradeScout API. Plain node:http, no framework.
 *   POST /api/runs                 {product, target_country, min_headcount?, max_headcount?}  → {run_id}
 *   GET  /api/runs                 recent runs
 *   GET  /api/runs/:id             run, steps, totals, report (when done), actions
 *   GET  /api/runs/:id/events      SSE stream of step/log events (replays history, then live)
 *   POST /api/runs/:id/resume      continue a killed or failed run
 *   POST /api/runs/:id/retry       {from: step}
 *   GET  /api/runs/:id/ledger      every call with cost and latency
 *   GET  /api/runs/:id/evidence    every claim with its source
 *   POST /api/actions/:id/approve | reject | execute
 *   GET  /api/health
 *   GET  /                         static frontend from ./public
 */
const PORT = Number(process.env.PORT ?? 8787);
const ledger = new Ledger();
const running = new Set<string>();

function start(runId: string, mode: "run" | "resume") {
  if (running.has(runId)) return;
  running.add(runId);
  if (mode === "resume") process.env.TRADESCOUT_KILLED = "1";
  runPipeline(ledger, runId, buildPipeline(), {
    log: (m) => emit(runId, { type: "log", message: m }),
    onStep: (name, status, info) => emit(runId, { type: "step", name, status, info: status === "done" ? undefined : info }),
  }).then(() => emit(runId, { type: "done" }))
    .catch((err) => emit(runId, { type: "error", message: String(err?.message ?? err) }))
    .finally(() => running.delete(runId));
}

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
const readBody = (req: IncomingMessage) => new Promise<any>((resolve, reject) => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const p = url.pathname; const m = req.method ?? "GET";
  try {
    if (m === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
    if (p === "/api/health") return json(res, 200, { ok: true, running: [...running], time: new Date().toISOString() });
    if (p === "/api/runs" && m === "POST") {
      const body = RequestSchema.parse(await readBody(req));
      const runId = ledger.createRun(body);
      start(runId, "run");
      return json(res, 202, { run_id: runId });
    }
    if (p === "/api/runs" && m === "GET") return json(res, 200, ledger.listRuns(30).map(r => ({ id: r.id, status: r.status, created_at: r.created_at, request: r.request, totals: ledger.totals(r.id) })));
    let mm: RegExpMatchArray | null;
    if ((mm = p.match(/^\/api\/runs\/([^/]+)$/)) && m === "GET") {
      const id = mm[1]; const run = ledger.getRun(id); if (!run) return json(res, 404, { error: "no such run" });
      const report = ledger.stepOutput<any>(id, "report")?.output ?? null;
      return json(res, 200, { run, steps: ledger.listSteps(id), totals: ledger.totals(id), actions: ledger.listActions(id), report, running: running.has(id), events: history(id).length });
    }
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/events$/)) && m === "GET") {
      const id = mm[1]; if (!ledger.getRun(id)) return json(res, 404, { error: "no such run" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
      let closed = false; let unsub: () => void = () => {};
      const listener = (e: any) => {
        if (closed) return;
        try { res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); } catch { closed = true; return; }
        if (e.type === "done" || e.type === "error") { closed = true; res.end(); queueMicrotask(() => unsub()); }
      };
      unsub = subscribe(id, listener);          // replays history synchronously; a finished run ends the stream here
      req.on("close", () => { closed = true; unsub(); }); return;
    }
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/resume$/)) && m === "POST") { const id = mm[1]; if (!ledger.getRun(id)) return json(res, 404, { error: "no such run" }); start(id, "resume"); return json(res, 202, { run_id: id, resumed: true }); }
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/retry$/)) && m === "POST") { const id = mm[1]; const b = await readBody(req); ledger.resetStepsFrom(id, b.from ?? "search", buildPipeline().map(s => s.name)); start(id, "resume"); return json(res, 202, { run_id: id, from: b.from ?? "search" }); }
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/ledger$/)) && m === "GET") return json(res, 200, { calls: ledger.listCalls(mm[1]), totals: ledger.totals(mm[1]), run: ledger.getRun(mm[1]) });
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/evidence$/)) && m === "GET") return json(res, 200, ledger.listEvidence(mm[1]));
    if ((mm = p.match(/^\/api\/actions\/([^/]+)\/(approve|reject|execute)$/)) && m === "POST") {
      const [, id, verb] = mm;
      if (verb === "execute") return json(res, 200, await executeApproved(ledger, id));
      ledger.decideAction(id, verb === "approve" ? "approved" : "rejected");
      return json(res, 200, ledger.getAction(id));
    }
    // static frontend
    if (m === "GET") {
      const rel = p === "/" ? "/index.html" : p;
      const file = normalize(join("public", rel));
      if (file.startsWith("public") && existsSync(file)) { res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); return res.end(readFileSync(file)); }
    }
    json(res, 404, { error: "not found" });
  } catch (err: any) {
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
    json(res, err?.name === "ZodError" ? 400 : 500, { error: String(err?.message ?? err) });
  }
});
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));
server.listen(PORT, () => console.log(`TradeScout API on http://localhost:${PORT}`));
