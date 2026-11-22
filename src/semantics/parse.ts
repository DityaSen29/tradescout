import type { TradeRequest, Evidence } from "../core/types.js";
import { resolveHs, type HsResolution } from "./hs.js";
import { resolveCountry, type Country } from "./country.js";
import { buildKeywordMap, type KeywordMap } from "./keywords.js";

export interface Resolved {
  status: "ok" | "needs_input" | "cannot_verify";
  questions: string[];
  hs: HsResolution;
  country: Country | null;
  keywords: KeywordMap;
  headcount: { min: number; max: number };
  filter_plan: {
    country_iso3: string | null;
    headcount: { min: number; max: number };
    industries: string[];
    query: string;
    mode: "hybrid";
  };
  evidence: Evidence[];
}

/**
 * Step 1: take the request in the customer's words and work out what finished work looks like.
 * Vague product → ask for one of up to three HS codes. Unknown country → cannot proceed, say what is missing.
 */
export function parseRequest(req: TradeRequest, retrieved_at = new Date().toISOString()): Resolved {
  const hs = resolveHs(req.product, { retrieved_at });
  const country = resolveCountry(req.target_country);
  const keywords = buildKeywordMap(req.product);
  const questions: string[] = [];
  const evidence: Evidence[] = [];
  if (!country) questions.push(`I cannot verify the target country "${req.target_country}". Give an ISO3 code or a country name from the UN list.`);
  if (hs.status === "none") questions.push(`I cannot map "${req.product}" to an HS code. Name the product as customs would (for example "nonwoven fabrics" or "basmati rice").`);
  if (hs.status === "ambiguous") questions.push(`"${req.product}" could be ${hs.candidates.slice(0, 3).map(c => `${c.code} (${c.text.slice(0, 50)})`).join("; ")}. Which one?`);
  if (hs.best) evidence.push({ claim: `HS ${hs.best.code} = ${hs.best.text}`, source_type: "comtrade", source_url: hs.source.url, record_id: hs.best.code, field: "text", record_date: null, retrieved_at: hs.source.retrieved_at });
  if (country) evidence.push({ claim: `${country.name} = ${country.iso3}`, source_type: "comtrade", source_url: "https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json", record_id: String(country.m49 ?? country.iso3), field: "PartnerCodeIsoAlpha3", record_date: null, retrieved_at });
  const status: Resolved["status"] = !country ? "cannot_verify" : hs.status === "ok" ? "ok" : "needs_input";
  return {
    status, questions, hs, country, keywords,
    headcount: { min: req.min_headcount, max: req.max_headcount },
    filter_plan: { country_iso3: country?.iso3 ?? null, headcount: { min: req.min_headcount, max: req.max_headcount }, industries: keywords.industries, query: keywords.query, mode: "hybrid" },
    evidence,
  };
}
