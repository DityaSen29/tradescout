/** Small, deterministic text helpers shared by the semantic layer. */
const STOP = new Set(["the", "a", "an", "of", "and", "or", "for", "in", "to", "with", "other", "nes", "n.e.s", "whether", "not", "than", "more", "less", "kg", "per", "thereof", "parts", "articles", "including", "excluding", "etc"]);
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
export const tokens = (s: string) => norm(s).split(/[\s-]+/).filter(t => t.length > 1 && !STOP.has(t));
export function stem(t: string): string {
  // light English stemmer: plurals and a few suffixes; enough for HS and industry text
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("sses")) return t.slice(0, -2);
  if (t.endsWith("ings") && t.length > 6) return t.slice(0, -4);
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("es") && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}
export const stems = (s: string) => tokens(s).map(stem);
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Whole-word phrase match on normalised text: "tea" does not match "steam". Plural/singular tolerant via stems. */
export function hasPhrase(text: string, phrase: string): boolean {
  const ts = stems(text), ps = stems(phrase);
  if (!ps.length) return false;
  for (let i = 0; i + ps.length <= ts.length; i++) { let ok = true; for (let j = 0; j < ps.length; j++) if (ts[i + j] !== ps[j]) { ok = false; break; } if (ok) return true; }
  return false;
}
