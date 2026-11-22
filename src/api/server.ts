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
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"].map(h => `${h}:${PORT}`));
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

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req: IncomingMessage) => new Promise<any>((resolve, reject) => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** Depth-first search of a stored response for the record whose id fields match. */
function findRecord(node: any, id: string, depth = 0): any | null {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const ids = [node.crustdata_company_id, node.crustdata_person_id, node.job_id, node.id, node?.basic_info?.crustdata_company_id].filter(v => v !== undefined && v !== null).map(String);
  if (ids.includes(id)) return node;
  if (node.company_data && findRecord(node.company_data, id, depth + 1)) return node.company_data;
  for (const v of Array.isArray(node) ? node : Object.values(node)) { const r = findRecord(v, id, depth + 1); if (r) return r; }
  return null;
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const p = url.pathname; const m = req.method ?? "GET";
  try {
    // approvals and paid runs are local only: no other site, and no rebound hostname, may drive them
    const origin = req.headers.origin;
    if (!LOCAL_HOSTS.has(req.headers.host ?? "") || (origin && origin !== `http://${req.headers.host}`)) return json(res, 403, { error: "local requests only" });
    if (p === "/api/limits" && m === "GET") return json(res, 200, ledger.spendToday());
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
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
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
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/record$/)) && m === "GET") {
      const runId = mm[1]; const endpoint = url.searchParams.get("endpoint") ?? ""; const id = url.searchParams.get("id") ?? ""; const field = url.searchParams.get("field") ?? "";
      const rows = ledger.db.prepare(`SELECT id, retrieved_at, response_json FROM calls WHERE run_id=? AND endpoint=? AND status='ok' AND response_json IS NOT NULL ORDER BY retrieved_at DESC`).all(runId, endpoint) as any[];
      for (const row of rows) {
        const found = findRecord(JSON.parse(row.response_json), id);
        if (found) {
          const value = field.split(".").reduce((o: any, k) => (o && typeof o === "object" ? o[k] : undefined), found);
          const html = `<!doctype html><meta charset="utf-8"><title>Record ${esc(id)}</title><body style="font-family:system-ui;max-width:900px;margin:30px auto;padding:0 16px;color:#1b2a41"><h1 style="font-size:20px">Crustdata ${esc(endpoint)} record ${esc(id)}</h1><p>Retrieved ${esc(row.retrieved_at)} by run ${esc(runId)}, call ${esc(row.id)}. Stored response, served locally; the API itself is POST-only.</p><h2 style="font-size:16px">Field <code>${esc(field)}</code></h2><pre style="background:#f3f5f1;padding:12px;border-left:3px solid #2e7d5b;white-space:pre-wrap">${esc(JSON.stringify(value, null, 2))}</pre><details><summary>Whole record</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(found, null, 2))}</pre></details></body>`;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html);
        }
      }
      return json(res, 404, { error: `record ${id} not found in stored responses for ${endpoint}` });
    }
    if ((mm = p.match(/^\/api\/runs\/([^/]+)\/graph$/)) && m === "GET") { const rep = ledger.stepOutput<any>(mm[1], "report")?.output; if (!rep) return json(res, 404, { error: "no report yet" }); return json(res, 200, { graph: rep.graph }); }
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
server.listen(PORT, "127.0.0.1", () => console.log(`TradeScout API on http://localhost:${PORT}`));
