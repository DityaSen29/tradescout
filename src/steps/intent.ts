import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";
import { and, f, or } from "../sources/crustdata.js";
import { crust, apiEvidence, BUYING_TITLE } from "./common.js";
import { scoreIntent } from "../scoring/intent.js";
import type { VetOutput } from "./vet.js";

/** Optional layer: buyer-intent signals from open job postings at the top candidates. */
export async function intentStep(ctx: StepCtx): Promise<LayerResult<Record<string, { open: number; buying: number; tags: string[] }>>> {
  const vet = ctx.outputs.vet as VetOutput;
  const ids = vet.enriched_ids.length ? vet.enriched_ids : (ctx.outputs.search as any).top_ids;
  const out: Record<string, { open: number; buying: number; tags: string[] }> = {};
  const evidence: LayerResult["evidence"] = [];
  let credits = 0, latency = 0;
  if (!ids.length) return { layer: "intent", status: "unavailable", reason: "no candidates", evidence, credits: 0, latency_ms: 0 };
  const r = await ctx.call({ source: "crustdata", endpoint: "/job/search", request: { ids, limit: 50 }, credits: (x: any) => x.credits }, async () => {
    const x = await crust().jobSearch({ filters: and(f("company.basic_info.crustdata_company_id", "in", ids.map(Number)), f("job_details.title", "is_not_null", true)), fields: ["job_details.title", "company.basic_info.crustdata_company_id", "metadata.date_added"], limit: 50 });
    return { jobs: x.data.jobs ?? x.data.results ?? x.data.items ?? [], credits: x.credits, retrieved_at: x.retrieved_at };
  });
  credits += r.credits; latency += r.latency_ms;
  const retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
  for (const id of ids) out[id] = { open: 0, buying: 0, tags: [] };
  for (const j of r.data.jobs as any[]) {
    const cid = String(j.company?.basic_info?.crustdata_company_id ?? j.company?.basic_info?.company_id ?? j.company_id ?? "");
    const title = j.job_details?.title ?? j.title ?? "";
    if (!out[cid]) continue;
    out[cid].open++;
    if (BUYING_TITLE.test(title)) { out[cid].buying++; evidence.push(apiEvidence(`open role "${title}" at company ${cid}`, "/job/search", String(j.job_id ?? j.id ?? `${cid}:${title}`), "job_details.title", retrieved_at, j.metadata?.date_added ?? null, ctx.runId)); }
  }
  for (const c of vet.candidates) {
    const o = out[c.company_id]; if (!o) continue;
    const it = scoreIntent({ open_jobs_total: o.open, buying_roles_open: o.buying, growth_6m: c.growth_6m, news_recent: null });
    o.tags = it.tags; c.intent_tags = it.tags;
  }
  ctx.log(`intent: ${r.data.jobs.length} postings across ${ids.length} companies (${r.cached ? "memo" : `${credits} credits`})`);
  return { layer: "intent", status: "ok", data: out, evidence, credits, latency_ms: latency };
}
