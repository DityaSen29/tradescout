import { readFileSync } from "node:fs";
import { FAMILIES, ROLE_TERMS } from "./synonyms.js";
import { norm, stems, tokens } from "./text.js";

export interface KeywordMap {
  families: string[];
  product_terms: string[];     // from the request itself
  expansions: string[];        // synonyms and neighbours a distributor would use
  role_terms: string[];        // distributor / importer / wholesaler ...
  industries: string[];        // exact Crustdata industry values, for the taxonomy filter
  query: string;               // the hybrid-search sentence
}

let INDUSTRIES: string[] | null = null;
function industries(path = "data/raw/static-linkedin-industries.json"): string[] {
  if (INDUSTRIES) return INDUSTRIES;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const arr: any[] = Array.isArray(raw) ? raw : raw.results ?? raw.values ?? [];
    INDUSTRIES = arr.map(x => typeof x === "string" ? x : x.name ?? x.value ?? x.label ?? x.text).filter(Boolean);
  } catch { INDUSTRIES = []; }
  return INDUSTRIES;
}

/** Build the keyword map that drives search, scoring and the graph. Deterministic. */
export function buildKeywordMap(product: string): KeywordMap {
  const q = norm(product);
  const fams = FAMILIES.filter(f => f.triggers.some(t => q.includes(t)));
  const product_terms = tokens(product);
  const expansions = [...new Set(fams.flatMap(f => f.expand))];
  const wanted = new Set([...fams.flatMap(f => f.industries), "Wholesale", "Import & Export", "Wholesale Import and Export", "International Trade and Development"]);
  const known = industries();
  const knownNorm = new Map(known.map(k => [norm(k), k]));
  const picked = new Set<string>();
  for (const w of wanted) { const hit = knownNorm.get(norm(w)); if (hit) picked.add(hit); }
  // also pick known industries sharing a stem with the product (e.g. "Textiles")
  const ps = new Set(stems(product));
  for (const k of known) { const ks = stems(k); if (ks.some(s => ps.has(s)) && /manufactur|wholesale|retail|import|trade|distribution/i.test(k)) picked.add(k); }
  const query = [...new Set([...expansions.slice(0, 4), ...product_terms])].join(" ") + " " + ["distributor", "importer", "wholesaler"].join(" ");
  return { families: fams.map(f => f.key), product_terms, expansions, role_terms: ROLE_TERMS, industries: [...picked], query: query.trim() };
}
