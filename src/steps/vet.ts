import type { StepCtx } from "../runner/pipeline.js";
import type { Candidate } from "../core/types.js";
import { flattenCompany } from "../sources/crustdata.js";
import { crust, apiEvidence, ADVERSE } from "./common.js";
import { scoreTrust } from "../scoring/trust.js";
import { screen, SANCTIONS_SOURCES } from "../sources/sanctions.js";
import type { SearchOutput } from "./search.js";

export interface VetOutput { candidates: Candidate[]; enriched_ids: string[]; notes: string[] }

/** Step: vet the top candidates. One enrich call for up to 5 ids, local sanctions screen, adverse news count, deterministic trust tier. */
export async function vetStep(ctx: StepCtx): Promise<VetOutput> {
  const search = ctx.outputs.search as SearchOutput;
  const ids = search.top_ids.map(Number).filter(n => Number.isFinite(n));
  const notes: string[] = [];
  const byId = new Map(search.candidates.map(c => [c.company_id, c]));
  let enrichedIds: string[] = [];
  let records = new Map<string, any>();
  let retrieved_at = new Date().toISOString();
  if (ids.length) {
    try {
      const r = await ctx.call({ source: "crustdata", endpoint: "/company/enrich", request: { ids, fields: ["basic_info", "headcount", "funding", "news"] }, credits: (x: any) => x.credits },
        async () => { const x = await crust().companyEnrich({ ids, fields: ["basic_info", "headcount", "funding", "news"] }); return { items: x.data.companies ?? x.data.items ?? (Array.isArray(x.data) ? x.data : []), credits: x.credits, retrieved_at: x.retrieved_at }; });
      retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
      for (const item of r.data.items as any[]) {
        const match = Array.isArray(item?.matches) ? item.matches[0] : item;           // enrich: { matched_on, match_type, matches: [{ confidence_score, company_data }] }
        const raw = match?.company_data ?? match;
        if (!raw) continue;
        const c = flattenCompany(raw);
        if (c.company_id) records.set(c.company_id, { raw, c, confidence: match?.confidence_score ?? null });
      }
      enrichedIds = [...records.keys()];
      ctx.log(`vet: enriched ${enrichedIds.length}/${ids.length} (${r.cached ? "memo" : `${r.credits} credits`})`);
    } catch (err: any) { notes.push(`enrich unavailable: ${err?.message ?? err}`); ctx.log(`vet: enrich failed (${err?.message ?? err}); tiers fall back to AMBER insufficient data`); }
  }
  const year = new Date().getFullYear();
  const since = new Date(Date.now() - 365 * 86400e3);
  for (const cand of search.candidates) {
    const rec = records.get(cand.company_id);
    const sanctions = screen(cand.name);
    const sanctionsEvidence = { claim: sanctions.hit ? `${cand.name} matches ${sanctions.list} entry "${sanctions.name}" (score ${sanctions.score})` : `${cand.name} not found on ${sanctions.checked_lists.join(", ")}${sanctions.near ? ` (nearest entry ${sanctions.near.name} at ${sanctions.near.score}, below the ${92} threshold, listed for a person)` : ""}`, source_type: "sanctions" as const, source_url: sanctions.hit && sanctions.list === "UN consolidated" ? SANCTIONS_SOURCES.UN : SANCTIONS_SOURCES.OFAC, record_id: sanctions.name, field: "name", record_date: null, retrieved_at };
    let adverse: number | null = null;
    if (rec) {
      const c = rec.c;
      Object.assign(cand, { headcount: c.headcount ?? cand.headcount, growth_6m: c.growth_6m ?? cand.growth_6m, growth_12m: c.growth_12m ?? cand.growth_12m, year_founded: c.year_founded ?? cand.year_founded, domain: c.domain ?? cand.domain, description: c.description ?? cand.description, industries: c.industries.length ? c.industries : cand.industries });
      const newsRaw: any = rec.raw.news; const newsList: any[] = Array.isArray(newsRaw) ? newsRaw : Array.isArray(newsRaw?.items) ? newsRaw.items : Array.isArray(newsRaw?.articles) ? newsRaw.articles : [];
      const news: any[] = newsList.filter((n: any) => { const d = n.date ?? n.published_at ?? n.publish_date; return !d || new Date(d) >= since; });
      const adverseItems = news.filter(n => ADVERSE.test(`${n.title ?? ""} ${n.summary ?? n.description ?? ""}`));
      adverse = adverseItems.length;
      for (const n of adverseItems.slice(0, 3)) if (n.url) cand.evidence.push({ claim: `adverse news: ${n.title}`, source_type: "web", source_url: n.url, record_date: n.date ?? n.published_at ?? null, retrieved_at });
      const ep = "/company/enrich";
      if (c.growth_12m != null) cand.evidence.push(apiEvidence(`${cand.name} 12-month headcount change ${c.growth_12m}%`, ep, cand.company_id, "headcount.growth_percent.12m", retrieved_at, null, ctx.runId));
      if (c.funding_usd != null) cand.evidence.push(apiEvidence(`${cand.name} total funding USD ${c.funding_usd}`, ep, cand.company_id, "funding.total_investment_usd", retrieved_at, null, ctx.runId));
      if (c.year_founded != null) cand.evidence.push(apiEvidence(`${cand.name} founded ${c.year_founded}`, ep, cand.company_id, "basic_info.year_founded", retrieved_at, null, ctx.runId));
      cand.evidence.push(apiEvidence(`${cand.name} news items in last 12 months: ${news.length}, adverse: ${adverse}`, ep, cand.company_id, "news", retrieved_at, ctx.runId));
    }
    const trust = scoreTrust({ headcount: cand.headcount, growth_12m: cand.growth_12m, year_founded: cand.year_founded, domain: cand.domain, sanctions: sanctions.checked_lists.length ? sanctions : null, adverse_news: adverse, enriched: !!rec, last_round_type: rec?.c.last_round_type ?? null }, year);
    cand.trust_tier = trust.tier; cand.trust_reasons = trust.reasons;
    cand.evidence.push(sanctionsEvidence);
    for (const e of cand.evidence) ctx.evidence(cand.company_id, e);
    if (!rec && ids.includes(Number(cand.company_id))) cand.unresolved.push("cannot verify: no enrichment record returned");
    if (sanctions.hit) cand.unresolved.push(`possible sanctions match on name only (${sanctions.list} "${sanctions.name}", score ${sanctions.score}); confirm identity before any contact`);
    if (!sanctions.hit && sanctions.near) cand.unresolved.push(`sanctions near-match below threshold (${sanctions.near.list} "${sanctions.near.name}", score ${sanctions.near.score}); not a hit, listed for a person`);
  }
  return { candidates: search.candidates, enriched_ids: enrichedIds, notes };
}
