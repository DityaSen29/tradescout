import { readFileSync } from "node:fs";
import { norm } from "./text.js";

export interface Country { iso3: string; iso2: string | null; name: string; m49: number | null }
let MAP: Map<string, Country> | null = null;
const ISO2 = new Map<string, Country>();
const ALIASES: Record<string, string> = {
  "uae": "ARE", "united arab emirates": "ARE", "dubai": "ARE", "abu dhabi": "ARE", "emirates": "ARE",
  "usa": "USA", "us": "USA", "united states": "USA", "united states of america": "USA", "america": "USA", "u s a": "USA",
  "uk": "GBR", "united kingdom": "GBR", "britain": "GBR", "great britain": "GBR", "england": "GBR",
  "germany": "DEU", "deutschland": "DEU", "holland": "NLD", "netherlands": "NLD", "the netherlands": "NLD",
  "south korea": "KOR", "korea": "KOR", "republic of korea": "KOR", "russia": "RUS", "vietnam": "VNM", "viet nam": "VNM",
  "turkey": "TUR", "turkiye": "TUR", "türkiye": "TUR", "czech republic": "CZE", "czechia": "CZE", "ivory coast": "CIV",
  "saudi": "SAU", "saudi arabia": "SAU", "ksa": "SAU", "iran": "IRN", "tanzania": "TZA", "bolivia": "BOL", "venezuela": "VEN",
  "laos": "LAO", "syria": "SYR", "moldova": "MDA", "brunei": "BRN", "hong kong": "HKG", "macau": "MAC", "taiwan": "TWN",
  "eu": "_EU", "europe": "_EU",
};

function load(paths = { partners: "data/raw/partnerAreas.json", crust: "data/raw/largest_headcount_country.json" }) {
  if (MAP) return MAP;
  MAP = new Map();
  const put = (k: string, c: Country) => { if (k) MAP!.set(norm(k), c); };
  try {
    const rows = JSON.parse(readFileSync(paths.partners, "utf8")).results as any[];
    for (const r of rows) {
      if (r.isGroup || !r.PartnerCodeIsoAlpha3 || String(r.PartnerCodeIsoAlpha3).startsWith("_")) continue;
      if (r.entryExpiredDate) continue;                                   // retired entries such as "USA and Puerto Rico (...1980)"
      const c: Country = { iso3: r.PartnerCodeIsoAlpha3, iso2: r.PartnerCodeIsoAlpha2 ?? null, name: String(r.PartnerDesc).trim(), m49: Number(r.PartnerCode) };
      put(c.iso3, c); put(c.name, c);
      if (c.iso2) ISO2.set(c.iso2.toLowerCase(), c);                       // two-letter codes live apart: they match only a bare two-letter input
    }
  } catch { /* partners file optional */ }
  try {
    const rows = JSON.parse(readFileSync(paths.crust, "utf8")) as any[];
    for (const r of rows) {
      const iso3 = r.iso_alpha3 ?? r.value ?? r.code; const name = r.name ?? r.label ?? r.text;
      if (!iso3 || !name) continue;
      const existing = [...MAP.values()].find(c => c.iso3 === iso3);
      const c: Country = existing ?? { iso3, iso2: null, name, m49: null };
      if (!existing) put(iso3, c);
      put(name, c);
    }
  } catch { /* crustdata list optional */ }
  for (const [alias, iso3] of Object.entries(ALIASES)) {
    const c = [...MAP.values()].find(x => x.iso3 === iso3);
    if (c) put(alias, c);
  }
  return MAP;
}

/** Resolve a country name, ISO2 or ISO3 to a Country, or null when no record settles it. A two-letter code counts only when it is the whole input. */
export function resolveCountry(input: string): Country | null {
  const m = load();
  const k = norm(input);
  if (!k) return null;
  if (k.length === 2) return ISO2.get(k) ?? m.get(k) ?? null;
  if (m.has(k)) return m.get(k)!;
  // tolerate "in Germany", "to the UAE": try the longest word-run first, never a lone two-letter word
  const words = k.split(" ").filter(Boolean);
  for (let n = words.length; n >= 1; n--) for (let i = 0; i + n <= words.length; i++) {
    const sub = words.slice(i, i + n).join(" ");
    if (sub.length <= 2) continue;
    if (m.has(sub)) return m.get(sub)!;
  }
  return null;
}
