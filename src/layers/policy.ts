import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";
import { crust } from "../steps/common.js";

/**
 * Policy layer: dated news on import policy for this product and market, via Crustdata web search (news sources).
 * Rules decide the flag; the model is not consulted. No dated article inside 12 months → "cannot verify".
 */
export interface PolicyData { summary: string; flag: "GREEN" | "AMBER" | "RED"; items: { title: string; url: string; date: string | null; kind: string }[] }
const RED_RX = /\b(import ban|banned|prohibit|anti-dumping dut|countervailing|safeguard dut|suspend)\w*/i;
const AMBER_RX = /\b(tariff|duty|duties|quota|regulation|CBAM|EUDR|REACH|labeling|certification|licen[cs]e|restriction|compliance deadline)\w*/i;
export async function policyStep(ctx: StepCtx): Promise<LayerResult<PolicyData>> {
  const parse = ctx.outputs.parse as any;
  const country = parse.country?.name; const hsText: string = (parse.hs.best?.text ?? ctx.request.product).split(";")[0].slice(0, 60);
  if (!country) return { layer: "policy", status: "unavailable", reason: "no target country", evidence: [], credits: 0, latency_ms: 0 };
  const query = `${country} import tariff ${ctx.request.product} India ${new Date().getFullYear()}`;
  const r = await ctx.call({ source: "crustdata", endpoint: "/web/search/live", request: { query, sources: ["news"] }, credits: (x: any) => x.credits }, async () => {
    const x = await crust().webSearch({ query, sources: ["news"], page: 1 });
    const results: any[] = x.data.results ?? x.data.data ?? x.data.items ?? [];
    return { results, credits: x.credits, retrieved_at: x.retrieved_at };
  });
  const since = Date.now() - 365 * 86400e3;
  const unwrap = (u: string) => { try { const x = new URL(u); if (x.hostname.endsWith("google.com") && x.pathname === "/goto") return x.searchParams.get("url")?.startsWith("http") ? x.searchParams.get("url")! : u; } catch { /* keep */ } return u; };
  const dateOf = (it: any) => { const d = it.published_date ?? it.date ?? it.published_at; if (d) return String(d); const m = String(it.snippet ?? "").match(/^([A-Z][a-z]{2} \d{1,2}, \d{4})\s*[—-]/); return m ? new Date(m[1]).toISOString().slice(0, 10) : null; };
  const items = (r.data.results as any[]).map(it => ({ title: String(it.title ?? ""), url: unwrap(String(it.url ?? it.link ?? "")), date: dateOf(it), snippet: String(it.snippet ?? it.description ?? it.content ?? "").slice(0, 300) }))
    .filter(it => it.url && (!it.date || new Date(it.date).getTime() >= since))
    .map(it => { const text = `${it.title} ${it.snippet}`; const kind = RED_RX.test(text) ? "restriction" : AMBER_RX.test(text) ? "policy change" : "mention"; return { title: it.title, url: it.url, date: it.date, kind }; })
    .filter(it => it.kind !== "mention").slice(0, 6);
  const flag: PolicyData["flag"] = items.some(i => i.kind === "restriction") ? "RED" : items.length ? "AMBER" : "GREEN";
  const retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
  if (!items.length) {
    const ev = { claim: `no dated news on import policy for ${ctx.request.product} into ${country} in the last 12 months (query: ${query})`, source_type: "web" as const, source_url: `https://api.crustdata.com/web/search/live#q=${encodeURIComponent(query)}`, record_date: null, retrieved_at };
    ctx.evidence("policy", ev);
    return { layer: "policy", status: "cannot_verify", reason: "no dated policy news found in the last 12 months; I cannot rule out a change", data: { summary: "No dated policy news found in the last 12 months. I cannot rule out a change; check the importer's customs authority before quoting.", flag: "GREEN", items: [] }, evidence: [ev], credits: r.credits, latency_ms: r.latency_ms };
  }
  const data: PolicyData = { summary: `${flag === "RED" ? "A restriction" : "A policy change"} is in the news: ${items[0].title}${items[0].date ? ` (${String(items[0].date).slice(0, 10)})` : ""}.`, flag, items };
  const evidence = items.map(i => ({ claim: `${i.kind}: ${i.title}`, source_type: "web" as const, source_url: i.url, record_date: i.date ? String(i.date).slice(0, 10) : null, retrieved_at }));
  for (const e of evidence) ctx.evidence("policy", e);
  ctx.log(`policy: ${flag}, ${items.length} dated items (${r.cached ? "memo" : `${r.credits} credits`})`);
  return { layer: "policy", status: "ok", data, evidence, credits: r.credits, latency_ms: r.latency_ms };
}
