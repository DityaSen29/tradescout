import { MemoryGraph, nid } from "../graph/model.js";
import { trustNumeric } from "./trust.js";
import type { Candidate } from "../core/types.js";

/**
 * Multi-facet ranking over the context graph.
 *   fit      what the company says it is (rules on its own record)
 *   graph    how well it sits in the request's neighbourhood: keyword coverage, family alignment,
 *            and support from similar peers (one round of fit propagation over SIMILAR_TO edges)
 *   intent   whether it is buying or expanding right now
 *   trust    GREEN 1, AMBER 0.5, RED 0 — RED is always ranked last and never recommended
 */
export const WEIGHTS = { fit: 0.45, graph: 0.25, intent: 0.15, trust: 0.15 };

export function graphScore(g: MemoryGraph, companyId: string, totalKeywords: number, fitOf: (id: string) => number): { score: number; detail: Record<string, number> } {
  const matches = g.edgesFrom(companyId, "MATCHES");
  const coverage = totalKeywords ? Math.min(1, matches.reduce((a, e) => a + Number(e.props.weight ?? 1), 0) / Math.min(4, totalKeywords)) : 0;
  const familyEdges = g.edgesFrom(companyId, "BELONGS_TO").length;
  const family = familyEdges > 0 ? 1 : 0;
  const peers = g.edgesFrom(companyId, "SIMILAR_TO");
  const support = peers.length ? peers.reduce((a, e) => a + Number(e.props.weight ?? 0.5) * (fitOf(e.to) / 100), 0) / peers.length : 0;
  const signals = g.edgesFrom(companyId, "HAS_SIGNAL").length;
  const signalScore = Math.min(1, signals / 3);
  const score = 0.45 * coverage + 0.2 * family + 0.25 * support + 0.1 * signalScore;
  return { score: Number(score.toFixed(3)), detail: { coverage, family, support: Number(support.toFixed(3)), signals: signalScore } };
}

/** Add SIMILAR_TO edges between candidates that share keywords or industries. */
export function linkSimilar(g: MemoryGraph, companyIds: string[]) {
  const sets = new Map<string, Set<string>>();
  for (const id of companyIds) {
    const s = new Set<string>();
    for (const e of g.edgesFrom(id, "MATCHES")) s.add(e.to);
    for (const e of g.edgesFrom(id, "LOCATED_IN")) s.add(e.to);
    const n = g.nodes.get(id); for (const ind of ((n?.props.industries as string[]) ?? [])) s.add(`ind:${ind}`);
    sets.set(id, s);
  }
  for (let i = 0; i < companyIds.length; i++) for (let j = i + 1; j < companyIds.length; j++) {
    const a = sets.get(companyIds[i])!, b = sets.get(companyIds[j])!;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    const w = inter / Math.max(1, Math.min(a.size, b.size));
    if (w >= 0.34) { g.upsertEdge({ from: companyIds[i], to: companyIds[j], type: "SIMILAR_TO", props: { weight: Number(w.toFixed(2)) } }); g.upsertEdge({ from: companyIds[j], to: companyIds[i], type: "SIMILAR_TO", props: { weight: Number(w.toFixed(2)) } }); }
  }
}

export function rankCandidates(g: MemoryGraph, cands: Candidate[], totalKeywords: number): Candidate[] {
  const fitOf = (id: string) => cands.find(c => nid("Company", c.company_id) === id)?.fit_score ?? 0;
  for (const c of cands) {
    const gs = graphScore(g, nid("Company", c.company_id), totalKeywords, fitOf);
    c.graph_score = gs.score;
    const intent = Math.min(1, c.intent_tags.length / 3);
    c.rank_score = Number((100 * (WEIGHTS.fit * c.fit_score / 100 + WEIGHTS.graph * gs.score + WEIGHTS.intent * intent + WEIGHTS.trust * trustNumeric(c.trust_tier))).toFixed(1));
  }
  const order = { GREEN: 0, AMBER: 1, RED: 2 };
  return [...cands].sort((a, b) => (order[a.trust_tier] - order[b.trust_tier]) || (b.rank_score - a.rank_score));
}
