import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";

/**
 * Tariff layer: World Bank WITS "tradestats-tariff" (no key): simple-average applied tariff the market charges on
 * Indian goods in the product's WITS sector, against the MFN average. Sector level, not line level, and the summary says so.
 * EU members report as the EU (reporter "eun").
 */
export interface TariffData { summary: string; sector: string; reporter: string; year: number; india_rate: number | null; mfn_rate: number | null; preference: boolean | null }
const EU = new Set(["AUT","BEL","BGR","HRV","CYP","CZE","DNK","EST","FIN","FRA","DEU","GRC","HUN","IRL","ITA","LVA","LTU","LUX","MLT","NLD","POL","PRT","ROU","SVK","SVN","ESP","SWE"]);
const SECTORS: [RegExp, string][] = [[/^0[1-5]/, "Animal"], [/^(0[6-9]|1[0-5])/, "Vegetable"], [/^(1[6-9]|2[0-4])/, "Food Products"], [/^2[5-7]/, "Minerals"], [/^27/, "Fuels"], [/^(2[8-9]|3[0-8])/, "Chemicals"], [/^(39|40)/, "Plastic or Rubber"], [/^4[1-3]/, "Hides and Skins"], [/^4[4-9]/, "Wood"], [/^(5\d|6[0-3])/, "Textiles"], [/^6[4-7]/, "Footwear"], [/^(6[8-9]|70|71)/, "Stone and Glass"], [/^(7[2-9]|8[0-3])/, "Metals"], [/^8[4-5]/, "Mach and Elec"], [/^8[6-9]/, "Transportation"], [/^9\d/, "Miscellaneous"]];
export const sectorOf = (hs: string) => SECTORS.find(([rx]) => rx.test(hs))?.[1] ?? "All Products";

export async function tariffStep(ctx: StepCtx): Promise<LayerResult<TariffData>> {
  const parse = ctx.outputs.parse as any;
  const code: string | undefined = parse.hs.best?.code; const iso3: string | null = parse.country?.iso3 ?? null;
  if (!code || !iso3) return { layer: "tariff", status: "unavailable", reason: !iso3 ? "no target country" : "no HS code resolved", evidence: [], credits: 0, latency_ms: 0 };
  const sector = sectorOf(code); const reporter = EU.has(iso3) ? "eun" : iso3.toLowerCase(); const year = new Date().getFullYear() - 4;
  const mk = (indicator: string) => `https://wits.worldbank.org/API/V1/SDMX/V21/datasource/tradestats-tariff/reporter/${reporter}/year/${year}/partner/ind/product/${encodeURIComponent(sector)}/indicator/${indicator}`;
  const fetchRate = async (indicator: string) => {
    const url = mk(indicator);
    const r = await ctx.call({ source: "wits", endpoint: "/API/V1/SDMX/V21/datasource/tradestats-tariff", request: { url } }, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
      if (!res.ok) throw new Error(`wits ${res.status}`);
      const xml = await res.text(); const m = xml.match(/OBS_VALUE="([\d.]+)"/);
      return { rate: m ? Number(Number(m[1]).toFixed(2)) : null };
    });
    return { rate: r.data.rate, url, retrieved_at: r.retrieved_at, latency: r.latency_ms };
  };
  const ind = await fetchRate("AHS-SMPL-AVRG");
  const mfn = await fetchRate("MFN-SMPL-AVRG").catch(() => ({ rate: null, url: mk("MFN-SMPL-AVRG"), retrieved_at: new Date().toISOString(), latency: 0 }));
  if (ind.rate == null && mfn.rate == null) return { layer: "tariff", status: "cannot_verify", reason: `WITS has no ${year} tariff record for ${reporter.toUpperCase()} on ${sector} from India`, evidence: [{ claim: `no WITS tariff record for ${reporter}/${sector}/${year}`, source_type: "wits", source_url: ind.url, record_date: String(year), retrieved_at: ind.retrieved_at }], credits: 0, latency_ms: ind.latency + mfn.latency };
  const preference = ind.rate != null && mfn.rate != null ? ind.rate < mfn.rate - 0.05 : null;
  const who = reporter === "eun" ? `the EU (covers ${iso3})` : iso3;
  const data: TariffData = { summary: `${who} charges a ${ind.rate != null ? `${ind.rate}%` : "n/a"} simple-average applied tariff on Indian ${sector.toLowerCase()} (MFN average ${mfn.rate != null ? `${mfn.rate}%` : "n/a"}${preference ? "; a preference applies" : ""}), WITS ${year}, sector level, not the HS ${code} line.`, sector, reporter, year, india_rate: ind.rate, mfn_rate: mfn.rate, preference };
  const evidence = [[ind, "applied, partner India"], [mfn, "MFN"]].filter(([x]: any) => x.rate != null).map(([x, label]: any) => ({ claim: `${who} ${label} simple-average tariff on ${sector}: ${x.rate}%`, source_type: "wits" as const, source_url: x.url, record_id: `${reporter}:${sector}:${year}`, field: "OBS_VALUE", record_date: String(year), retrieved_at: x.retrieved_at }));
  for (const e of evidence) ctx.evidence("tariff", e);
  ctx.log(`tariff: ${sector} India ${ind.rate ?? "n/a"}% vs MFN ${mfn.rate ?? "n/a"}% (${reporter}, ${year})`);
  return { layer: "tariff", status: "ok", data, evidence, credits: 0, latency_ms: ind.latency + mfn.latency };
}
