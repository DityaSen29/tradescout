import { existsSync } from "node:fs";
if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* ignore */ } }
import { Ledger } from "./ledger/ledger.js";
import { runPipeline } from "./runner/pipeline.js";
import { RequestSchema } from "./core/types.js";
import { buildPipeline } from "./pipeline.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1] ?? "true";
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
const ledger = new Ledger();
const log = (m: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function main() {
  if (cmd === "run") {
    const request = RequestSchema.parse({
      product: flags.product, target_country: flags.country,
      min_headcount: flags.min ? Number(flags.min) : undefined, max_headcount: flags.max ? Number(flags.max) : undefined,
      fob_price_usd: flags.fob ? Number(flags.fob) : undefined,
    });
    const runId = ledger.createRun(request);
    log(`run ${runId}`);
    const outputs = await runPipeline(ledger, runId, buildPipeline(), { log });
    console.log(JSON.stringify({ run_id: runId, report: outputs.report, ledger: ledger.totals(runId) }, null, 2));
  } else if (cmd === "resume") {
    const runId = positional[0];
    if (!runId) throw new Error("usage: resume <run-id>");
    process.env.TRADESCOUT_KILLED = "1";
    log(`resuming ${runId}`);
    const outputs = await runPipeline(ledger, runId, buildPipeline(), { log });
    console.log(JSON.stringify({ run_id: runId, report: outputs.report, ledger: ledger.totals(runId) }, null, 2));
  } else if (cmd === "ledger") {
    const runId = positional[0];
    console.log(JSON.stringify({ run: ledger.getRun(runId), steps: ledger.listSteps(runId), calls: ledger.listCalls(runId), totals: ledger.totals(runId), actions: ledger.listActions(runId) }, null, 2));
  } else if (cmd === "check") {
    const { Crustdata } = await import("./sources/crustdata.js");
    const c = new Crustdata();
    const cr = await c.credits();
    console.log("credits:", JSON.stringify(cr.data));
    const ep = await c.endpoints();
    const d: any = ep.data; const list = d.endpoints ?? d.data ?? d;
    const rows: any[] = Array.isArray(list) ? list : Object.entries(list).map(([k, v]: any) => ({ endpoint: k, ...(typeof v === "object" ? v : { value: v }) }));
    console.log(`endpoints: ${rows.length}`);
    for (const r of rows) console.log(JSON.stringify(r).slice(0, 220));
  } else if (cmd === "runs") {
    console.log(JSON.stringify(ledger.listRuns(20).map(r => ({ id: r.id, status: r.status, created_at: r.created_at, request: r.request })), null, 2));
  } else if (cmd === "approve" || cmd === "reject") {
    ledger.decideAction(positional[0], cmd === "approve" ? "approved" : "rejected");
    console.log(JSON.stringify(ledger.getAction(positional[0]), null, 2));
  } else {
    console.log(`usage:\n  run --product <text> --country <name|ISO3> [--min 20 --max 2000 --fob 12.5]\n  resume <run-id>\n  ledger <run-id>\n  runs\n  approve|reject <action-id>`);
  }
}
main().catch(err => { console.error(err?.stack ?? err); process.exit(1); });
