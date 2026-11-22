import type { StepCtx } from "../runner/pipeline.js";
import { MAX_CREDITS } from "../core/limits.js";
import type { Candidate } from "../core/types.js";
import { and, f, flattenCompany } from "../sources/crustdata.js";
import { crust, apiEvidence, iso3Of, SEARCH_FIELDS } from "./common.js";
import { scoreFit } from "../scoring/fit.js";
import { MemoryGraph, nid } from "../graph/model.js";
import { cleanName, tokenSetRatio } from "../sources/sanctions.js";

export interface SearchOutput { candidates: Candidate[]; top_ids: string[]; widened: boolean; total_count: number | null; graph: ReturnType<MemoryGraph["toJSON"]>; notes: string[] }

/** Step: find counterparties. One Crustdata company search (widened once on zero results), fit-scored, de-duplicated, lookalikes flagged. */
export async function searchStep(ctx: StepCtx): Promise<SearchOutput> {
  const parse = ctx.outputs.parse as any;
  const plan = parse.filter_plan as { country_iso3: string; headcount: { min: number; max: number }; query: string };
  const km = parse.keywords;
  const notes: string[] = [];
  const run = async (min: number, max: number) => ctx.call({
    source: "crustdata", endpoint: "/company/search", request: { country: plan.country_iso3, min, max, query: plan.query, fields: SEARCH_FIELDS, limit: 25 },
    maxUnits: MAX_CREDITS.companySearch(25),
    credits: (r: any) => r.credits,
  }, async () => {
    const r = await crust().companySearch({ filters: and(f("locations.country", "=", plan.country_iso3), f("headcount.total", "=>", min), f("headcount.total", "=<", max)), fields: SEARCH_FIELDS, limit: 25, query: plan.query, mode: "hybrid" });
    return { companies: r.data.companies ?? [], total_count: r.data.total_count ?? null, credits: r.credits, retrieved_at: r.retrieved_at };
  });
  let res = await run(plan.headcount.min, plan.headcount.max);
  let widened = false;
  if (!res.data.companies.length) { widened = true; notes.push(`no match at headcount ${plan.headcount.min}-${plan.headcount.max}; widened once to 5-10000`); res = await run(5, 10000); }
  const retrieved_at = res.data.retrieved_at ?? res.retrieved_at;

  const g = new MemoryGraph();
  g.upsertNode({ label: "Request", id: nid("Request", ctx.runId), props: { product: ctx.request.product, country: plan.country_iso3 } });
  if (parse.hs.best) { g.upsertNode({ label: "HS", id: nid("HS", parse.hs.best.code), props: { text: parse.hs.best.text } }); g.upsertEdge({ from: nid("Request", ctx.runId), to: nid("HS", parse.hs.best.code), type: "ASKS_FOR", props: {} }); }
  g.upsertNode({ label: "Country", id: nid("Country", plan.country_iso3), props: {} });
  g.upsertEdge({ from: nid("Request", ctx.runId), to: nid("Country", plan.country_iso3), type: "IN_MARKET", props: {} });
  for (const fam of km.families) { g.upsertNode({ label: "Family", id: nid("Family", fam), props: {} }); if (parse.hs.best) g.upsertEdge({ from: nid("Family", fam), to: nid("HS", parse.hs.best.code), type: "MAPS_TO", props: {} }); }
  for (const k of [...km.expansions, ...km.product_terms]) { g.upsertNode({ label: "Keyword", id: nid("Keyword", k), props: {} }); for (const fam of km.families) g.upsertEdge({ from: nid("Keyword", k), to: nid("Family", fam), type: "BELONGS_TO", props: {} }); }

  const byKey = new Map<string, Candidate>();
  const dupNotes: string[] = [];
  for (const raw of res.data.companies as any[]) {
    const c = flattenCompany(raw);
    if (!c.company_id || !c.name) continue;
    const country = iso3Of(c.country);
    const fit = scoreFit({ ...c, country }, km, { country_iso3: plan.country_iso3, headcount: plan.headcount });
    const key = c.domain ? `d:${c.domain.toLowerCase()}` : `n:${cleanName(c.name)}`;
    if (byKey.has(key)) { const prev = byKey.get(key)!; prev.unresolved.push(`duplicate record ${c.company_id} merged (same ${c.domain ? "domain" : "name"})`); dupNotes.push(`${c.name}: merged ${c.company_id} into ${prev.company_id}`); continue; }
    const cand: Candidate = {
      company_id: c.company_id, name: c.name, domain: c.domain, country, city: c.city, headcount: c.headcount, growth_6m: c.growth_6m, growth_12m: c.growth_12m,
      year_founded: c.year_founded, description: c.description, industries: c.industries, linkedin: c.linkedin,
      fit_score: fit.score, fit_reasons: fit.reasons, trust_tier: "AMBER", trust_reasons: ["not yet vetted"], intent_tags: [], graph_score: 0, rank_score: 0, contact: null, evidence: [], unresolved: [],
    };
    const ep = "/company/search";
    cand.evidence.push(apiEvidence(`${c.name} is a company record (${c.domain ?? "no domain"})`, ep, c.company_id, "basic_info.name", retrieved_at, null, ctx.runId));
    if (c.headcount != null) cand.evidence.push(apiEvidence(`${c.name} headcount ${c.headcount}`, ep, c.company_id, "headcount.total", retrieved_at, null, ctx.runId));
    if (country) cand.evidence.push(apiEvidence(`${c.name} located in ${country}`, ep, c.company_id, "locations.country", retrieved_at, null, ctx.runId));
    if (c.growth_6m != null) cand.evidence.push(apiEvidence(`${c.name} 6-month headcount growth ${c.growth_6m}%`, ep, c.company_id, "headcount.growth_percent.6m", retrieved_at, null, ctx.runId));
    for (const e of cand.evidence) ctx.evidence(c.company_id, e);
    const id = nid("Company", c.company_id);
    g.upsertNode({ label: "Company", id, props: { name: c.name, domain: c.domain, headcount: c.headcount, industries: c.industries, fit: fit.score } });
    g.upsertEdge({ from: id, to: nid("Country", country ?? "unknown"), type: "LOCATED_IN", props: {} });
    for (const k of fit.keyword_hits) g.upsertEdge({ from: id, to: nid("Keyword", k), type: "MATCHES", props: { weight: 1 } });
    for (const r of fit.role_hits) { g.upsertNode({ label: "Keyword", id: nid("Keyword", r), props: { role: true } }); g.upsertEdge({ from: id, to: nid("Keyword", r), type: "MATCHES", props: { weight: 0.5 } }); }
    if (fit.keyword_hits.length) for (const fam of km.families) g.upsertEdge({ from: id, to: nid("Family", fam), type: "BELONGS_TO", props: {} });
    byKey.set(key, cand);
  }
  const candidates = [...byKey.values()];
  // lookalike names with different domains: flag both, never merge
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const s = tokenSetRatio(candidates[i].name, candidates[j].name);
    const first = (n: string) => cleanName(n).split(" ")[0] ?? "";
    const sharedDistinctiveFirst = first(candidates[i].name).length >= 5 && first(candidates[i].name) === first(candidates[j].name);
    if (s >= 70 || sharedDistinctiveFirst) { candidates[i].unresolved.push(`lookalike of ${candidates[j].name} (${candidates[j].company_id}); verify before contacting`); candidates[j].unresolved.push(`lookalike of ${candidates[i].name} (${candidates[i].company_id}); verify before contacting`); }
  }
  candidates.sort((a, b) => b.fit_score - a.fit_score);
  const top_ids = candidates.slice(0, 5).map(c => c.company_id);
  if (dupNotes.length) notes.push(...dupNotes);
  ctx.log(`search: ${candidates.length} candidates (${res.cached ? "memo" : `${res.credits} credits`}), top ${top_ids.length} go to vetting`);
  return { candidates, top_ids, widened, total_count: res.data.total_count, graph: g.toJSON(), notes };
}
