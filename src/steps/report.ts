import type { StepCtx } from "../runner/pipeline.js";
import type { Report, LayerResult } from "../core/types.js";
import { MemoryGraph, nid } from "../graph/model.js";
import { linkSimilar, rankCandidates } from "../scoring/rank.js";
import { hashOf } from "../ledger/ledger.js";
import type { VetOutput } from "./vet.js";
import type { SearchOutput } from "./search.js";

/** Final step: rank over the graph, assemble the report, save a snapshot and diff it against the previous run of the same request. */
export async function reportStep(ctx: StepCtx): Promise<Report & { monitor: LayerResult; graph: unknown }> {
  const parse = ctx.outputs.parse as any;
  const search = ctx.outputs.search as SearchOutput;
  const vet = ctx.outputs.vet as VetOutput;
  const g = new MemoryGraph();
  for (const n of search.graph.nodes) g.upsertNode(n as any);
  for (const e of search.graph.edges) g.upsertEdge(e as any);
  for (const c of vet.candidates) { for (const t of c.intent_tags) { const sid = nid("Signal", `${c.company_id}:${t}`); g.upsertNode({ label: "Signal", id: sid, props: { kind: "intent", text: t } }); g.upsertEdge({ from: nid("Company", c.company_id), to: sid, type: "HAS_SIGNAL", props: {} }); } }
  linkSimilar(g, vet.candidates.map(c => nid("Company", c.company_id)));
  const candidates = rankCandidates(g, vet.candidates, parse.keywords.expansions.length);
  const layer = (name: string) => (ctx.outputs[name] as LayerResult | undefined) ?? null;
  const run = ctx.ledger.getRun(ctx.runId)!;
  const totals = ctx.ledger.totals(ctx.runId);
  const policyUndated: string[] = ((ctx.outputs.policy as any)?.data?.undated ?? []).map((u: any) => `policy: undated mention "${u.title}" needs a person to check its date`);
  const unresolved = [...parse.questions, ...policyUndated, ...candidates.flatMap(c => c.unresolved.map(u => `${c.name}: ${u}`)), ...search.notes, ...vet.notes];
  const limitations = [
    `Only the top ${vet.enriched_ids.length} by fit were enriched and vetted; the rest carry AMBER "not yet vetted".`,
    "Contacts come from an indexed people dataset refreshed every 1-30 days; a person may have moved.",
    "Sanctions screening is a name match against OFAC SDN and the UN consolidated list, not a full KYB.",
    "No shipment records or payment history: the trust tier reads headcount, news, age, domain and sanctions.",
  ];
  const reqHash = hashOf({ product: ctx.request.product, country: parse.country?.iso3 });
  const prev = ctx.ledger.previousSnapshot(reqHash, ctx.runId);
  let monitor: LayerResult;
  if (prev) {
    const prevById = new Map((prev.report.candidates as any[]).map(c => [c.company_id, c]));
    const changes: string[] = [];
    for (const c of candidates) {
      const p = prevById.get(c.company_id);
      if (!p) { changes.push(`new: ${c.name}`); continue; }
      if (p.trust_tier !== c.trust_tier) changes.push(`${c.name}: trust ${p.trust_tier} → ${c.trust_tier}`);
      if (p.headcount !== c.headcount) changes.push(`${c.name}: headcount ${p.headcount} → ${c.headcount}`);
      if ((p.contact?.name ?? null) !== (c.contact?.name ?? null)) changes.push(`${c.name}: contact ${p.contact?.name ?? "none"} → ${c.contact?.name ?? "none"}`);
    }
    for (const [id, p] of prevById) if (!candidates.find(c => c.company_id === id)) changes.push(`dropped: ${p.name}`);
    monitor = { layer: "monitor", status: "ok", data: { since: prev.taken_at, previous_run: prev.run_id, changes }, evidence: [{ claim: `compared with snapshot ${prev.run_id}`, source_type: "ledger", source_url: `ledger://snapshots/${prev.run_id}`, record_date: prev.taken_at, retrieved_at: new Date().toISOString() }], credits: 0, latency_ms: 0 };
  } else monitor = { layer: "monitor", status: "unavailable", reason: "first run for this request; nothing to compare", evidence: [], credits: 0, latency_ms: 0 };
  const top = candidates.filter(c => c.trust_tier !== "RED").slice(0, 3);
  const summary = `${candidates.length} counterparties for ${ctx.request.product} (HS ${parse.hs.best?.code ?? "?"}) in ${parse.country?.name}: ${top.map(c => `${c.name} [${c.trust_tier}, fit ${c.fit_score}]`).join("; ") || "none passed vetting"}. ${unresolved.length} items need a person.`;
  const report = {
    run_id: ctx.runId, request: ctx.request,
    resolved: { hs_code: parse.hs.best?.code ?? null, hs_text: parse.hs.best?.text ?? null, country_iso3: parse.country?.iso3 ?? null, keywords: parse.keywords.expansions },
    summary, market: layer("market"), tariff: layer("tariff"), policy: layer("policy"), candidates, unresolved,
    actions: ctx.ledger.listActions(ctx.runId), limitations,
    ledger: { ...totals, elapsed_ms: Date.now() - Date.parse(run.created_at), credit_limit: run.credit_limit, time_limit_ms: run.time_limit_ms },
    monitor, graph: g.toJSON(),
  };
  ctx.ledger.saveSnapshot(ctx.runId, reqHash, { candidates: candidates.map(c => ({ company_id: c.company_id, name: c.name, trust_tier: c.trust_tier, headcount: c.headcount, contact: c.contact })) });
  return report;
}
