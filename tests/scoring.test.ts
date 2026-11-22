import { describe, it, expect } from "vitest";
import { scoreFit } from "../src/scoring/fit.js";
import { scoreTrust } from "../src/scoring/trust.js";
import { scoreIntent } from "../src/scoring/intent.js";
import { rankCandidates, linkSimilar } from "../src/scoring/rank.js";
import { MemoryGraph, nid } from "../src/graph/model.js";
import { buildKeywordMap } from "../src/semantics/keywords.js";
import { screen, tokenSetRatio } from "../src/sources/sanctions.js";
import type { Candidate } from "../src/core/types.js";

const km = buildKeywordMap("industrial textiles");
const target = { country_iso3: "DEU", headcount: { min: 20, max: 2000 } };
// Mock companies are for tests only (event rule). Shapes mirror flattened Crustdata records.
const base = { industries: [] as string[], growth_6m: null, growth_12m: null, funding_usd: null };
const mocks = [
  { id: "c1", name: "Nordfaser Technische Textilien GmbH", description: "Distributor and importer of technical textiles, nonwovens and industrial fabrics for automotive and construction.", country: "DEU", headcount: 140, year_founded: 1998, growth_6m: 4, industries: ["Textile Manufacturing", "Wholesale"] },
  { id: "c2", name: "Nordfaser Handels GmbH", description: "Trading company for textiles.", country: "DEU", headcount: 25, year_founded: 2015, growth_6m: 0, industries: ["Wholesale"] },
  { id: "c3", name: "Berlin Software Labs", description: "We build SaaS for logistics.", country: "DEU", headcount: 60, year_founded: 2019, growth_6m: 30, industries: ["Software Development"] },
  { id: "c4", name: "Rhein Vliesstoffe AG", description: "Nonwovens wholesaler and converter, industrial fabrics.", country: "DEU", headcount: 900, year_founded: 1975, growth_12m: -35, industries: ["Textile Manufacturing"] },
  { id: "c5", name: "Unknown Importer", description: null, country: "DEU", headcount: null, year_founded: null, industries: [] },
];

describe("fit", () => {
  it("prefers a textile distributor over a software company", () => {
    const f1 = scoreFit({ ...base, ...mocks[0] }, km, target), f3 = scoreFit({ ...base, ...mocks[2] }, km, target);
    expect(f1.score).toBeGreaterThan(f3.score + 30);
    expect(f1.reasons.join(" ")).toMatch(/distributor|importer/);
  });
});

describe("trust", () => {
  it("is AMBER, never GREEN, when data is missing", () => {
    const t = scoreTrust({ headcount: null, growth_12m: null, year_founded: null, domain: null, sanctions: null, adverse_news: null, enriched: false });
    expect(t.tier).toBe("AMBER"); expect(t.fired).toContain("NO_ENRICHMENT");
  });
  it("is RED on a headcount collapse or a sanctions match", () => {
    expect(scoreTrust({ headcount: 900, growth_12m: -35, year_founded: 1975, domain: "x.de", sanctions: { hit: false }, adverse_news: 0, enriched: true }).tier).toBe("RED");
    expect(scoreTrust({ headcount: 50, growth_12m: 2, year_founded: 2000, domain: "x.de", sanctions: { hit: true, name: "X", list: "OFAC SDN", score: 95 }, adverse_news: 0, enriched: true }).tier).toBe("RED");
  });
  it("is GREEN only when no rule fires", () => {
    expect(scoreTrust({ headcount: 140, growth_12m: 5, year_founded: 1998, domain: "nordfaser.de", sanctions: { hit: false }, adverse_news: 0, enriched: true }).tier).toBe("GREEN");
  });
});

describe("intent", () => {
  it("tags companies hiring buying roles", () => {
    expect(scoreIntent({ open_jobs_total: 8, buying_roles_open: 2, growth_6m: 6, news_recent: 0 }).tags[0]).toMatch(/buying/);
  });
});

describe("rank over the graph", () => {
  it("ranks the well-connected distributor first and the RED company last", () => {
    const g = new MemoryGraph();
    const cands: Candidate[] = mocks.map(m => {
      const fit = scoreFit({ ...base, ...m }, km, target);
      const trust = scoreTrust({ headcount: m.headcount, growth_12m: (m as any).growth_12m ?? null, year_founded: m.year_founded, domain: m.description ? "x.de" : null, sanctions: { hit: false }, adverse_news: 0, enriched: !!m.description });
      const id = nid("Company", m.id);
      g.upsertNode({ label: "Company", id, props: { name: m.name, industries: m.industries } });
      g.upsertEdge({ from: id, to: nid("Country", "DEU"), type: "LOCATED_IN", props: {} });
      for (const k of fit.keyword_hits) g.upsertEdge({ from: id, to: nid("Keyword", k), type: "MATCHES", props: { weight: 1 } });
      if (fit.keyword_hits.length) g.upsertEdge({ from: id, to: nid("Family", "technical_textiles"), type: "BELONGS_TO", props: {} });
      return { company_id: m.id, name: m.name, domain: null, country: m.country, city: null, headcount: m.headcount, growth_6m: (m as any).growth_6m ?? null, growth_12m: (m as any).growth_12m ?? null, year_founded: m.year_founded, description: m.description, industries: m.industries, linkedin: null, fit_score: fit.score, fit_reasons: fit.reasons, trust_tier: trust.tier, trust_reasons: trust.reasons, intent_tags: [], graph_score: 0, rank_score: 0, contact: null, evidence: [], unresolved: [] };
    });
    linkSimilar(g, cands.map(c => nid("Company", c.company_id)));
    const ranked = rankCandidates(g, cands, km.expansions.length);
    expect(ranked[0].name).toMatch(/Nordfaser Technische/);
    expect(ranked[ranked.length - 1].trust_tier).toBe("RED");
    expect(ranked[0].graph_score).toBeGreaterThan(ranked.find(c => c.name.includes("Software"))!.graph_score);
  });
});

describe("sanctions screen", () => {
  it("matches a listed entity and clears an honest lookalike", () => {
    expect(tokenSetRatio("Aerocaribbean Airlines", "AEROCARIBBEAN AIRLINES")).toBeGreaterThanOrEqual(92);
    const hit = screen("Aerocaribbean Airlines S.A.");
    expect(hit.hit).toBe(true); expect(hit.list).toBe("OFAC SDN");
    const clear = screen("Nordfaser Technische Textilien GmbH");
    expect(clear.hit).toBe(false);
  });
});
