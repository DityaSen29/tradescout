import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";

/**
 * Market layer: UN Comtrade public preview (no key, 500 rows). Imports of the HS code into the target country,
 * from the world and from India, last five reported years. Optional: a timeout leaves the shortlist untouched.
 */
export interface MarketData { summary: string; hs: string; years: { period: number; world_usd: number | null; india_usd: number | null; india_share: number | null }[]; cagr_world: number | null; cagr_india: number | null; india_rank: number | null }
const INDIA = 699, WORLD = 0;
export async function marketStep(ctx: StepCtx): Promise<LayerResult<MarketData>> {
  const parse = ctx.outputs.parse as any;
  const code: string | undefined = parse.hs.best?.code; const m49: number | null = parse.country?.m49 ?? null;
  if (!code || !m49) return { layer: "market", status: "unavailable", reason: !code ? "no HS code resolved" : "no UN country code for target", evidence: [], credits: 0, latency_ms: 0 };
  const hs = code.length > 6 ? code.slice(0, 6) : code;
  const now = new Date().getFullYear(); const periods = [now - 5, now - 4, now - 3, now - 2, now - 1].join(",");
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${m49}&period=${periods}&partnerCode=${WORLD},${INDIA}&cmdCode=${hs}&flowCode=M&maxRecords=500&format=json`;
  const r = await ctx.call({ source: "comtrade", endpoint: "/public/v1/preview/C/A/HS", request: { url } }, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`comtrade ${res.status}`);
    const j: any = await res.json(); return { rows: (j.data ?? []) as any[], count: j.count ?? null };
  });
  const rows = r.data.rows;
  if (!rows.length) return { layer: "market", status: "cannot_verify", reason: `Comtrade returned no import rows for HS ${hs} into ${parse.country.name}; the reporter may not have filed yet`, evidence: [{ claim: `no Comtrade rows for HS ${hs}, reporter ${m49}`, source_type: "comtrade", source_url: url, record_date: null, retrieved_at: r.retrieved_at }], credits: 0, latency_ms: r.latency_ms };
  const byYear = new Map<number, { world: number | null; india: number | null }>();
  for (const row of rows) {
    const y = Number(row.period ?? row.refYear); const v = Number(row.primaryValue ?? row.fobvalue ?? row.cifvalue ?? 0); const partner = Number(row.partnerCode);
    const e = byYear.get(y) ?? { world: null, india: null };
    if (partner === WORLD) e.world = (e.world ?? 0) + v; else if (partner === INDIA) e.india = (e.india ?? 0) + v;
    byYear.set(y, e);
  }
  const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([period, e]) => ({ period, world_usd: e.world, india_usd: e.india, india_share: e.world && e.india != null ? Number((100 * e.india / e.world).toFixed(2)) : null }));
  const cagr = (a: number | null | undefined, b: number | null | undefined, n: number) => a && b && n > 0 ? Number((100 * (Math.pow(b / a, 1 / n) - 1)).toFixed(1)) : null;
  const first = years[0], last = years[years.length - 1]; const n = years.length - 1;
  const data: MarketData = { summary: "", hs, years, cagr_world: cagr(first?.world_usd, last?.world_usd, n), cagr_india: cagr(first?.india_usd, last?.india_usd, n), india_rank: null };
  const fmt = (v: number | null) => v == null ? "n/a" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}bn` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}m` : `$${Math.round(v / 1e3)}k`;
  data.summary = `${parse.country.name} imported ${fmt(last?.world_usd)} of HS ${hs} in ${last?.period ?? "?"}${data.cagr_world != null ? ` (${data.cagr_world > 0 ? "+" : ""}${data.cagr_world}%/yr over ${n} years)` : ""}; from India ${fmt(last?.india_usd)}${last?.india_share != null ? `, a ${last.india_share}% share` : ""}${data.cagr_india != null ? ` (${data.cagr_india > 0 ? "+" : ""}${data.cagr_india}%/yr)` : ""}.`;
  const evidence = years.map(y => ({ claim: `${parse.country.name} imports of HS ${hs} in ${y.period}: world ${fmt(y.world_usd)}, India ${fmt(y.india_usd)}`, source_type: "comtrade" as const, source_url: url, record_id: `${m49}:${hs}:${y.period}`, field: "primaryValue", record_date: String(y.period), retrieved_at: r.retrieved_at }));
  for (const e of evidence) ctx.evidence("market", e);
  ctx.log(`market: ${years.length} years from Comtrade (${r.cached ? "memo" : `${r.latency_ms} ms`})`);
  return { layer: "market", status: "ok", data, evidence, credits: 0, latency_ms: r.latency_ms };
}
