import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";

/**
 * Tariff layer: World Bank WITS TRN datasource (no key). Applied tariff on the HS6 line for Indian origin vs MFN.
 * The SDMX endpoint is parsed with a tolerant regex; anything unexpected becomes "unavailable" with the reason.
 */
export interface TariffData { summary: string; hs6: string; year: number | null; india_rate: number | null; mfn_rate: number | null; preference: boolean | null }
export async function tariffStep(ctx: StepCtx): Promise<LayerResult<TariffData>> {
  const parse = ctx.outputs.parse as any;
  const best: string | undefined = parse.hs.best?.code; const iso3: string | null = parse.country?.iso3 ?? null;
  if (!best || !iso3) return { layer: "tariff", status: "unavailable", reason: !iso3 ? "no target country" : "no HS code resolved", evidence: [], credits: 0, latency_ms: 0 };
  // WITS needs a 6-digit line. A 4-digit heading takes its best-scoring subheading from the parse candidates, and says so.
  let code = best; let note = "";
  if (code.length < 6) {
    const cands: { code: string }[] = parse.hs.candidates ?? [];
    const child = cands.find(c => c.code.length >= 6 && c.code.startsWith(best)) ?? cands.find(c => c.code.length >= 6);
    if (!child) return { layer: "tariff", status: "unavailable", reason: `HS ${best} is a heading; no 6-digit subheading resolved to look up duty`, evidence: [], credits: 0, latency_ms: 0 };
    code = child.code; note = ` (heading ${best}; duty read for subheading ${code.slice(0, 6)})`;
  }
  const hs6 = code.slice(0, 6); const year = new Date().getFullYear() - 2;
  const mk = (partner: string) => `https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/${iso3}/partner/${partner}/product/${hs6}/year/${year}/datatype/reported`;
  const fetchRate = async (partner: string) => {
    const url = mk(partner);
    const r = await ctx.call({ source: "wits", endpoint: "/API/V1/SDMX/V21/datasource/TRN", request: { url } }, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`wits ${res.status}`);
      const xml = await res.text();
      const m = xml.match(/OBS_VALUE="([\d.]+)"/) ?? xml.match(/<Value[^>]*>([\d.]+)<\/Value>/) ?? xml.match(/<generic:ObsValue value="([\d.]+)"/);
      return { rate: m ? Number(m[1]) : null, bytes: xml.length };
    });
    return { rate: r.data.rate, url, retrieved_at: r.retrieved_at, latency: r.latency_ms };
  };
  const ind = await fetchRate("IND");
  const mfn = await fetchRate("000").catch(() => ({ rate: null, url: mk("000"), retrieved_at: new Date().toISOString(), latency: 0 }));
  if (ind.rate == null && mfn.rate == null) return { layer: "tariff", status: "cannot_verify", reason: `WITS has no reported tariff for ${iso3} on HS ${hs6} in ${year}`, evidence: [{ claim: `no WITS tariff record for ${iso3}/${hs6}/${year}`, source_type: "wits", source_url: ind.url, record_date: String(year), retrieved_at: ind.retrieved_at }], credits: 0, latency_ms: ind.latency + mfn.latency };
  const preference = ind.rate != null && mfn.rate != null ? ind.rate < mfn.rate : null;
  const data: TariffData = { summary: `Applied duty in ${iso3} on HS ${hs6} for Indian origin: ${ind.rate != null ? `${ind.rate}%` : "n/a"}${mfn.rate != null ? ` (MFN ${mfn.rate}%${preference ? ", a preference applies" : ""})` : ""}, WITS ${year}${note}.`, hs6, year, india_rate: ind.rate, mfn_rate: mfn.rate, preference };
  const evidence = [ind, mfn].filter(x => x.rate != null).map((x, i) => ({ claim: `${iso3} applied tariff on HS ${hs6}, ${i === 0 ? "partner India" : "MFN"}: ${x.rate}%`, source_type: "wits" as const, source_url: x.url, record_date: String(year), retrieved_at: x.retrieved_at }));
  for (const e of evidence) ctx.evidence("tariff", e);
  ctx.log(`tariff: India ${ind.rate ?? "n/a"}% vs MFN ${mfn.rate ?? "n/a"}%`);
  return { layer: "tariff", status: "ok", data, evidence, credits: 0, latency_ms: ind.latency + mfn.latency };
}
