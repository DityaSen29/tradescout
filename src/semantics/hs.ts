import { readFileSync } from "node:fs";
import { stems, norm, hasPhrase } from "./text.js";
import { FAMILIES } from "./synonyms.js";

export interface HsHit { code: string; text: string; level: 2 | 4 | 6; score: number }
export interface HsResolution { status: "ok" | "ambiguous" | "none"; best: HsHit | null; candidates: HsHit[]; confidence: number; source: { url: string; retrieved_at: string } }

interface HsRow { id: string; text: string; aggrlevel: number }
let INDEX: { row: HsRow; stems: Set<string> }[] | null = null;
const H6_URL = "https://comtradeapi.un.org/files/v1/app/reference/H6.json";

function load(path = "data/raw/H6.json") {
  if (INDEX) return INDEX;
  const rows = (JSON.parse(readFileSync(path, "utf8")).results as HsRow[]).filter(r => r.aggrlevel === 4 || r.aggrlevel === 6 || r.aggrlevel === 2);
  INDEX = rows.map(row => ({ row, stems: new Set(stems(row.text.replace(/^\d+\s*-\s*/, ""))) }));
  return INDEX;
}

/** Resolve plain-English product text to an HS code. Deterministic: family hints first, then token overlap. */
export function resolveHs(product: string, opts: { path?: string; retrieved_at?: string } = {}): HsResolution {
  const idx = load(opts.path);
  const q = norm(product);
  const qs = stems(product);
  const hinted = new Set<string>();
  for (const f of FAMILIES) if (f.triggers.some(t => hasPhrase(q, t))) f.hs_prefixes.forEach(p => hinted.add(p));

  const hits: HsHit[] = [];
  for (const { row, stems: rs } of idx) {
    let overlap = 0; for (const s of qs) if (rs.has(s)) overlap++;
    if (overlap === 0 && hinted.size === 0) continue;
    const base = qs.length ? overlap / qs.length : 0;
    const inFamily = [...hinted].some(p => row.id.startsWith(p));
    const prefixBonus = inFamily ? (overlap > 0 ? 0.6 : 0.3) : 0;
    const levelBonus = row.aggrlevel === 4 ? 0.15 : row.aggrlevel === 6 ? 0.1 : 0; // prefer headings over chapters
    const score = base + prefixBonus + levelBonus - Math.min(0.2, rs.size / 100); // mild penalty for very long descriptions
    if (score > 0.3) hits.push({ code: row.id, text: row.text.replace(/^\d+\s*-\s*/, ""), level: row.aggrlevel as 2 | 4 | 6, score: Number(score.toFixed(3)) });
  }
  hits.sort((a, b) => b.score - a.score || a.code.length - b.code.length);
  const candidates = hits.slice(0, 5);
  const best = candidates[0] ?? null;
  const second = candidates[1]?.score ?? 0;
  const confidence = best ? Number(Math.min(1, best.score - second + (best.score > 0.7 ? 0.3 : 0)).toFixed(2)) : 0;
  const source = { url: H6_URL, retrieved_at: opts.retrieved_at ?? new Date().toISOString() };
  if (!best) return { status: "none", best: null, candidates, confidence: 0, source };
  // ambiguous when the runner-up is from a different 4-digit heading and nearly as good
  const differentHeading = candidates.some(c => c !== best && c.code.slice(0, 4) !== best.code.slice(0, 4) && best.score - c.score < 0.15);
  const nearTie = candidates.some(c => c !== best && c.code.slice(0, 4) !== best.code.slice(0, 4) && best.score - c.score < 0.05);
  const weak = best.score < 0.75 && !hinted.size;                       // no family hint and thin word overlap: do not pretend
  return { status: differentHeading || nearTie || weak ? "ambiguous" : "ok", best, candidates, confidence, source };
}

/** Exact lookup of a 4- or 6-digit code in the HS 2022 list. */
export function lookupHs(code: string, path?: string): HsHit | null {
  const row = load(path).find(x => x.row.id === code);
  return row ? { code: row.row.id, text: row.row.text.replace(/^\d+\s*-\s*/, ""), level: row.row.aggrlevel as 2 | 4 | 6, score: 1 } : null;
}
