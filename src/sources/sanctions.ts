import { readFileSync, existsSync } from "node:fs";
import { norm } from "../semantics/text.js";

/** Local sanctions screen over the OFAC SDN CSV and the UN consolidated list. No key, no network at run time. */
export interface SanctionsHit { hit: boolean; name?: string; list?: string; score?: number; near?: { name: string; list: string; score: number } | null; checked_lists: string[]; source_urls: string[] }
const SUFFIX = /\b(gmbh|ag|ltd|limited|llc|inc|corp|corporation|co|company|pvt|private|plc|sa|srl|bv|nv|kg|pte|spa|oy|ab|as|sarl|sdn bhd|fze|fzc|llp)\b\.?/g;
export const cleanName = (s: string) => norm(s.replace(/\b([a-z])\.\s*([a-z])\.?\s*([a-z])?\.?/gi, (_m, a, b, c) => a + b + (c ?? ""))) // S.A. → sa, L.L.C. → llc
  .replace(SUFFIX, " ").split(" ").filter(t => t.length > 1).join(" ").trim();
export function tokenSetRatio(a: string, b: string): number {
  const A = new Set(cleanName(a).split(" ").filter(Boolean)), B = new Set(cleanName(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return Math.round((100 * 2 * inter) / (A.size + B.size)); // Dice coefficient over name tokens
}

let LISTS: { name: string; list: string }[] | null = null;
export const SANCTIONS_SOURCES = { OFAC: "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv", UN: "https://scsanctions.un.org/resources/xml/en/consolidated.xml" };
export function loadLists(paths = { sdn: "data/raw/sdn.csv", un: "data/raw/un_consolidated.xml" }) {
  if (LISTS) return LISTS;
  LISTS = [];
  if (existsSync(paths.sdn)) {
    for (const line of readFileSync(paths.sdn, "utf8").split("\n")) {
      const m = line.match(/^\d+,"([^"]+)"/); if (m && m[1] !== "-0-") LISTS.push({ name: m[1], list: "OFAC SDN" });
    }
  }
  if (existsSync(paths.un)) {
    const xml = readFileSync(paths.un, "utf8");
    for (const m of xml.matchAll(/<(?:FIRST_NAME|ALIAS_NAME)>([^<]{3,})<\/(?:FIRST_NAME|ALIAS_NAME)>/g)) LISTS.push({ name: m[1].trim(), list: "UN consolidated" });
  }
  return LISTS;
}

export function screen(name: string, threshold = 92): SanctionsHit {
  const lists = loadLists();
  const checked = [...new Set(lists.map(l => l.list))];
  if (!lists.length) return { hit: false, near: null, checked_lists: [], source_urls: [] };
  let best: { name: string; list: string; score: number } | null = null;
  const q = cleanName(name); if (q.length < 3) return { hit: false, near: null, checked_lists: checked, source_urls: Object.values(SANCTIONS_SOURCES) };
  const qTokens = new Set(q.split(" "));
  for (const l of lists) {
    const ln = cleanName(l.name);
    // cheap prefilter: share at least one token of length >= 4
    let share = false; for (const t of qTokens) if (t.length >= 4 && ln.includes(t)) { share = true; break; }
    if (!share) continue;
    const s = tokenSetRatio(q, ln);
    if (!best || s > best.score) best = { name: l.name, list: l.list, score: s };
  }
  const hit = !!best && best.score >= threshold && cleanName(best.name).split(" ").length >= 2;
  return { hit, ...(hit ? { name: best!.name, list: best!.list, score: best!.score } : {}), near: best && !hit && best.score >= 75 ? best : null, checked_lists: checked, source_urls: Object.values(SANCTIONS_SOURCES) };
}
