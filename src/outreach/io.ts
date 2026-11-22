import type { Ledger } from "../ledger/ledger.js";
import { hashOf } from "../ledger/ledger.js";
import { paidProvider } from "../core/limits.js";
import type { StepCtx } from "../runner/pipeline.js";

export type Call = StepCtx["call"];
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "HttpError"; }
}

/**
 * The ctx.call contract for work that outlives a pipeline run (a campaign lasts 14 days, so the run's
 * time ceiling cannot apply). Spend caps still apply. Responses are never stored: they hold mail and tokens.
 */
export function makeCall(ledger: Ledger, runId: string, step = "outreach"): Call {
  return async (meta, fn) => {
    const provider = paidProvider(meta.source);
    const hold = provider ? ledger.reserveSpend(runId, provider, meta.maxUnits ?? 0) : null;
    const t0 = Date.now();
    const row = { run_id: runId, step, source: meta.source, endpoint: meta.endpoint, request_hash: hashOf(meta.request), response_json: null };
    try {
      const data = await fn();
      const reported = provider === "llm" ? meta.model_cost_usd?.(data) : meta.credits?.(data);
      const units = !provider ? 0 : typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : meta.maxUnits!;
      if (hold) ledger.settleSpend(hold, units);
      const latency_ms = Date.now() - t0;
      const credits = provider === "llm" ? 0 : units;
      ledger.recordCall({ ...row, status: "ok", credits, model_cost_usd: provider === "llm" ? units : 0, latency_ms, note: null });
      return { data, cached: false, retrieved_at: new Date().toISOString(), latency_ms, credits };
    } catch (err: any) {
      if (hold && err?.status >= 400 && err.status < 500 && err.status !== 408) ledger.settleSpend(hold, 0);
      ledger.recordCall({ ...row, status: "error", credits: 0, model_cost_usd: 0, latency_ms: Date.now() - t0, note: String(err?.message ?? err).slice(0, 200) });
      throw err;
    }
  };
}

/** fetch with a timeout. Error text carries the provider's short reason only, never the URL or the request. */
export async function httpJson<T>(name: string, url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (err: any) { throw new Error(`${name}: no answer (${err?.name ?? "network error"})`); }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!res.ok) {
    const why = body?.error_description ?? body?.error?.message ?? body?.description ?? body?.error ?? "";
    throw new HttpError(res.status, `${name}: HTTP ${res.status} ${String(why).slice(0, 160)}`.trim());
  }
  if (body === null) throw new Error(`${name}: unreadable response`);
  return body as T;
}
