import { Ledger, hashOf, now } from "../ledger/ledger.js";
import type { Evidence, TradeRequest } from "../core/types.js";
import { BudgetExceeded } from "../core/types.js";
import { paidProvider } from "../core/limits.js";

/**
 * A pipeline is an ordered list of steps. Each step's output is committed to the ledger before the
 * next starts. On resume, done steps are skipped and their outputs reloaded; the first unfinished step
 * runs again. Paid calls inside a step are memoised per run by request hash, so a re-run step does not
 * pay twice. Set TRADESCOUT_KILL_AFTER=<step> or TRADESCOUT_KILL_DURING=<step> to simulate a crash.
 */
export interface StepCtx {
  runId: string;
  request: TradeRequest;
  ledger: Ledger;
  outputs: Record<string, unknown>;
  step: string;
  log: (msg: string) => void;
  /** Wrap any external call: budget check, timing, cost ledger, per-run memo. */
  call: <T>(meta: { source: string; endpoint: string; request: unknown; maxUnits?: number; credits?: (res: T) => number | null; model_cost_usd?: (res: T) => number; cacheable?: boolean }, fn: () => Promise<T>) => Promise<{ data: T; cached: boolean; retrieved_at: string; latency_ms: number; credits: number }>;
  evidence: (subject: string | null, e: Evidence) => void;
}
export interface StepDef { name: string; run: (ctx: StepCtx) => Promise<unknown>; optional?: boolean }

export interface RunOptions { log?: (msg: string) => void; onStep?: (name: string, status: "start" | "done" | "skip" | "fail" | "unavailable", info?: unknown) => void }

export async function runPipeline(ledger: Ledger, runId: string, steps: StepDef[], opts: RunOptions = {}): Promise<Record<string, unknown>> {
  if (!ledger.getRun(runId)) throw new Error(`unknown run ${runId}`);
  const owner = ledger.acquireRun(runId);
  try { return await runSteps(ledger, runId, steps, opts); } finally { ledger.releaseRun(runId, owner); }
}

async function runSteps(ledger: Ledger, runId: string, steps: StepDef[], opts: RunOptions): Promise<Record<string, unknown>> {
  const run = ledger.getRun(runId)!;
  const log = opts.log ?? (() => {});
  const outputs: Record<string, unknown> = {};
  ledger.setRunStatus(runId, "running");

  for (const step of steps) {
    const prior = ledger.stepOutput(runId, step.name);
    if (prior?.status === "done") {
      outputs[step.name] = prior.output;
      opts.onStep?.(step.name, "skip", { reused: true });
      log(`↺ ${step.name}: reused checkpoint`);
      continue;
    }
    if (process.env.TRADESCOUT_KILL_DURING === step.name && !process.env.TRADESCOUT_KILLED) {
      ledger.startStep(runId, step.name);
      log(`☠ simulated kill during ${step.name}`);
      process.exit(137);
    }
    ledger.startStep(runId, step.name);
    opts.onStep?.(step.name, "start", { attempt: (prior?.attempts ?? 0) + 1 });
    const ctx = makeCtx(ledger, runId, run.request, outputs, step.name, log);
    try {
      ledger.assertBudget(runId);
      const out = await step.run(ctx);
      ledger.finishStep(runId, step.name, out);
      outputs[step.name] = out;
      opts.onStep?.(step.name, "done", out);
      log(`✓ ${step.name}`);
    } catch (err: any) {
      if (err instanceof BudgetExceeded) {
        ledger.failStep(runId, step.name, err.message);
        ledger.setRunStatus(runId, "budget_exceeded");
        opts.onStep?.(step.name, "fail", err.message);
        throw err;
      }
      if (step.optional) {
        const out = { layer: step.name, status: "unavailable", reason: String(err?.message ?? err), evidence: [], credits: 0, latency_ms: 0 };
        ledger.finishStep(runId, step.name, out);
        outputs[step.name] = out;
        opts.onStep?.(step.name, "unavailable", out.reason);
        log(`⚠ ${step.name}: unavailable (${out.reason})`);
      } else {
        ledger.failStep(runId, step.name, String(err?.stack ?? err));
        ledger.setRunStatus(runId, "failed");
        opts.onStep?.(step.name, "fail", String(err?.message ?? err));
        throw err;
      }
    }
    if (process.env.TRADESCOUT_KILL_AFTER === step.name && !process.env.TRADESCOUT_KILLED) {
      log(`☠ simulated kill after ${step.name}`);
      process.exit(137);
    }
  }
  ledger.setRunStatus(runId, "done");
  return outputs;
}

function makeCtx(ledger: Ledger, runId: string, request: TradeRequest, outputs: Record<string, unknown>, step: string, log: (m: string) => void): StepCtx {
  return {
    runId, request, ledger, outputs, step, log,
    evidence: (subject, e) => { ledger.addEvidence(runId, step, subject, e); },
    call: async (meta, fn) => {
      const requestHash = hashOf({ source: meta.source, endpoint: meta.endpoint, request: meta.request });
      if (meta.cacheable !== false) {
        const prior = ledger.findCall(runId, requestHash);
        if (prior) {
          ledger.recordCall({ run_id: runId, step, source: meta.source, endpoint: meta.endpoint, request_hash: requestHash, status: "cached", credits: 0, model_cost_usd: 0, latency_ms: 0, response_json: null, note: `memo of call ${prior.id}` });
          return { data: JSON.parse(prior.response_json!) as any, cached: true, retrieved_at: prior.retrieved_at, latency_ms: 0, credits: 0 };
        }
      }
      ledger.assertBudget(runId);
      const provider = paidProvider(meta.source);
      const hold = provider ? ledger.reserveSpend(runId, provider, meta.maxUnits ?? 0) : null;
      const t0 = Date.now();
      try {
        const data = await fn();
        const latency_ms = Date.now() - t0;
        const reported = provider === "llm" ? meta.model_cost_usd?.(data) : meta.credits?.(data);
        // no usable charge reported by a paid provider: count the worst case
        const units = !provider ? 0 : typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : meta.maxUnits!;
        const credits = provider === "llm" ? 0 : units;
        const model_cost_usd = provider === "llm" ? units : 0;
        if (hold) ledger.settleSpend(hold, units);
        const retrieved_at = now();
        ledger.recordCall({ run_id: runId, step, source: meta.source, endpoint: meta.endpoint, request_hash: requestHash, status: "ok", credits, model_cost_usd, latency_ms, retrieved_at, response_json: JSON.stringify(data), note: null });
        return { data, cached: false, retrieved_at, latency_ms, credits };
      } catch (err: any) {
        // only a client-error rejection is known to be free; timeouts, 5xx and bad bodies keep their hold
        if (hold && err?.status >= 400 && err.status < 500 && err.status !== 408) ledger.settleSpend(hold, 0);
        ledger.recordCall({ run_id: runId, step, source: meta.source, endpoint: meta.endpoint, request_hash: requestHash, status: "error", credits: 0, model_cost_usd: 0, latency_ms: Date.now() - t0, response_json: null, note: String(err?.message ?? err) });
        throw err;
      }
    },
  };
}
