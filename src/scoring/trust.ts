import type { TrustTier } from "../core/types.js";

export interface TrustInput {
  headcount: number | null; growth_12m: number | null; year_founded: number | null; domain: string | null;
  sanctions: { hit: boolean; name?: string; list?: string; score?: number } | null;   // null = screen unavailable
  adverse_news: number | null;                                                       // null = not checked
  enriched: boolean;                                                                 // false = no enrichment record
  last_round_type?: string | null;
}
export interface Trust { tier: TrustTier; reasons: string[]; fired: string[] }

/** Counterparty trust tier. Deterministic, ordered: RED rules first, then AMBER, else GREEN. Missing data is AMBER, never GREEN. */
export function scoreTrust(t: TrustInput, year = new Date().getFullYear()): Trust {
  const fired: string[] = []; const reasons: string[] = [];
  let tier: TrustTier = "GREEN";
  const amber = (code: string, why: string) => { if (tier !== "RED") tier = "AMBER"; fired.push(code); reasons.push(why); };
  const red = (code: string, why: string) => { tier = "RED"; fired.push(code); reasons.push(why); };
  if (t.sanctions?.hit) red("SANCTIONS_MATCH", `name matches ${t.sanctions.list ?? "a sanctions list"} entry "${t.sanctions.name}" (score ${t.sanctions.score})`);
  if (t.adverse_news != null && t.adverse_news >= 2) red("ADVERSE_NEWS_2", `${t.adverse_news} adverse news items in the last 12 months`);
  if (t.growth_12m != null && t.growth_12m <= -30) red("HEADCOUNT_COLLAPSE", `12-month headcount down ${t.growth_12m.toFixed(0)}%`);
  if (!t.enriched) amber("NO_ENRICHMENT", "insufficient data: no enrichment record");
  if (t.sanctions === null) amber("SANCTIONS_UNCHECKED", "sanctions screen unavailable");
  if (t.adverse_news === 1) amber("ADVERSE_NEWS_1", "one adverse news item in the last 12 months");
  if (t.growth_12m != null && t.growth_12m > -30 && t.growth_12m <= -15) amber("HEADCOUNT_DECLINE", `12-month headcount down ${t.growth_12m.toFixed(0)}%`);
  if (t.headcount != null && t.headcount < 10) amber("TINY", `fewer than 10 employees (${t.headcount})`);
  if (!t.domain) amber("NO_DOMAIN", "no verified website domain");
  if (t.year_founded != null && year - t.year_founded < 3) amber("YOUNG", `founded ${t.year_founded}, under 3 years old`);
  if (t.last_round_type && /debt|distress/i.test(t.last_round_type)) amber("DEBT_ROUND", `last funding round: ${t.last_round_type}`);
  if (fired.length === 0) reasons.push("no risk rule fired");
  return { tier, reasons, fired };
}
export const trustNumeric = (tier: TrustTier) => tier === "GREEN" ? 1 : tier === "AMBER" ? 0.5 : 0;
