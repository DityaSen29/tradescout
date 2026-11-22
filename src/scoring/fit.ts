import { norm, stems } from "../semantics/text.js";
import type { KeywordMap } from "../semantics/keywords.js";

export interface FitInput { name: string; description: string | null; industries: string[]; country: string | null; headcount: number | null; year_founded: number | null; growth_6m: number | null; growth_12m: number | null; funding_usd?: number | null }
export interface Fit { score: number; reasons: string[]; keyword_hits: string[]; role_hits: string[] }

const W = { country: 20, headcount: 15, keywords: 25, role: 15, industry: 10, age: 5, growth: 10 };

/** Deterministic ICP fit, 0 to 100, with the reasons that fired. Rules decide; the LLM only narrates. */
export function scoreFit(c: FitInput, km: KeywordMap, target: { country_iso3: string | null; headcount: { min: number; max: number } }, year = new Date().getFullYear()): Fit {
  const reasons: string[] = []; let score = 0;
  const text = norm([c.name, c.description ?? "", c.industries.join(" ")].join(" "));
  const textStems = new Set(stems(text));
  if (target.country_iso3 && c.country === target.country_iso3) { score += W.country; reasons.push(`located in ${c.country}`); }
  if (c.headcount != null && c.headcount >= target.headcount.min && c.headcount <= target.headcount.max) { score += W.headcount; reasons.push(`headcount ${c.headcount} within ${target.headcount.min}-${target.headcount.max}`); }
  const terms = [...new Set([...km.expansions, ...km.product_terms])];
  const keyword_hits = terms.filter(t => { const ts = stems(t); return ts.length > 0 && ts.every(s => textStems.has(s)); });
  if (terms.length) { const part = Math.round(W.keywords * Math.min(1, keyword_hits.length / Math.min(4, terms.length))); score += part; if (keyword_hits.length) reasons.push(`describes itself with: ${keyword_hits.slice(0, 4).join(", ")}`); }
  const role_hits = km.role_terms.filter(r => textStems.has(stems(r)[0]));
  if (role_hits.length) { score += W.role; reasons.push(`trades as ${role_hits.slice(0, 3).join("/")}`); }
  const ind = c.industries.map(norm);
  const indHit = km.industries.filter(i => ind.includes(norm(i)));
  if (indHit.length) { score += W.industry; reasons.push(`industry: ${indHit[0]}`); }
  if (c.year_founded != null && year - c.year_founded >= 3) { score += W.age; reasons.push(`founded ${c.year_founded}`); }
  const g = c.growth_6m ?? c.growth_12m;
  if (g != null) { if (g > 0) { score += W.growth; reasons.push(`headcount growing ${g > 0 ? "+" : ""}${g.toFixed(0)}%`); } else if (g < -10) { score -= W.growth; reasons.push(`headcount shrinking ${g.toFixed(0)}%`); } }
  return { score: Math.max(0, Math.min(100, score)), reasons, keyword_hits, role_hits };
}
