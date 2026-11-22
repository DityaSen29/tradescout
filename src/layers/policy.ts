import type { StepCtx } from "../runner/pipeline.js";
import type { LayerResult } from "../core/types.js";
import { crust } from "../steps/common.js";

/**
 * Policy layer: dated news on import policy for this product and market, via Crustdata web search (news sources).
 * Rules decide the flag; the model is not consulted. No dated article inside 12 months → "cannot verify".
 */
export interface PolicyData { summary: string; flag: "GREEN" | "AMBER" | "RED"; items: { title: string; url: string; date: string | null; precision?: string | null; kind: string }[]; undated?: { title: string; url: string; kind: string }[] }
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
  const unwrap = (u: string) => { try { const x = new URL(u); if (x.hostname.endsWith("google.com") && x.pathname === "/goto") { const t = x.searchParams.get("url"); return t && t.startsWith("http") ? t : u; } } catch { /* keep */ } return u; };
  const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const year = new Date().getUTCFullYear();
  /** A full date from a field or a "Mon D, YYYY —" snippet prefix; else a year-only date found in the text; else null. */
  const dateOf = (it: any): { date: string | null; precision: "day" | "year" | null } => {
    const d = it.published_date ?? it.date ?? it.published_at; if (d) return { date: String(d).slice(0, 10), precision: "day" };
    const text = `${it.snippet ?? ""} ${it.title ?? ""}`;
    const m = text.match(/\b([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})\b/);
    if (m && MONTHS[m[1].toLowerCase()] != null) { const dt = new Date(Date.UTC(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]))); return { date: dt.toISOString().slice(0, 10), precision: "day" }; }
    const y = text.match(/\b(20\d{2})\b/); if (y) return { date: y[1], precision: "year" };
    return { date: null, precision: null };
  };
  const sinceYear = year - 1;
  const all = (r.data.results as any[]).map(it => { const d = dateOf(it); return { title: String(it.title ?? "").replace(/^\|\s*/, ""), url: unwrap(String(it.url ?? it.link ?? "")), date: d.date, precision: d.precision, snippet: String(it.snippet ?? it.description ?? it.content ?? "").slice(0, 300) }; })
    .filter(it => it.url)
    .map(it => { const text = `${it.title} ${it.snippet}`; const kind = RED_RX.test(text) ? "restriction" : AMBER_RX.test(text) ? "policy change" : "mention"; return { title: it.title, url: it.url, date: it.date, precision: it.precision, kind }; })
    .filter(it => it.kind !== "mention");
  const recent = (it: { date: string | null; precision: string | null }) => it.date != null && (it.precision === "year" ? Number(it.date) >= sinceYear : Date.parse(it.date) >= since);
  const items = all.filter(recent).sort((a, b) => Number(b.url.includes("google.com")) - Number(a.url.includes("google.com")) ? 0 : 0).sort((a, b) => Number(a.url.includes("google.com/goto")) - Number(b.url.includes("google.com/goto"))).slice(0, 6);
  const undated = all.filter(it => !recent(it)).slice(0, 4);
  const flag: PolicyData["flag"] = items.some(i => i.kind === "restriction") ? "RED" : items.length ? "AMBER" : "GREEN";
  const retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
  if (!items.length) {
    const ev = { claim: `no dated news on import policy for ${ctx.request.product} into ${country} in the last 12 months (query: ${query})`, source_type: "web" as const, source_url: `https://api.crustdata.com/web/search/live#q=${encodeURIComponent(query)}`, record_date: null, retrieved_at };
    ctx.evidence("policy", ev);
    for (const u of undated) ctx.evidence("policy", { claim: `undated mention: ${u.title}`, source_type: "web", source_url: u.url, record_date: null, retrieved_at });
    return { layer: "policy", status: "cannot_verify", reason: `no dated policy news found in the last 12 months${undated.length ? `; ${undated.length} undated mentions need a person` : ""}; I cannot rule out a change`, data: { summary: `No dated policy news found in the last 12 months${undated.length ? `; ${undated.length} undated mentions need a person to check` : ""}. I cannot rule out a change; check the importer's customs authority before quoting.`, flag: "GREEN", items: [], undated: undated.map(u => ({ title: u.title, url: u.url, kind: u.kind })) }, evidence: [ev], credits: r.credits, latency_ms: r.latency_ms };
  }
  const data: PolicyData = { summary: `${flag === "RED" ? "A restriction" : "A policy change"} is in the news: ${items[0].title} (${items[0].date}${items[0].precision === "year" ? ", year only" : ""})${undated.length ? `; ${undated.length} undated mentions need a person` : ""}.`, flag, items, undated: undated.map(u => ({ title: u.title, url: u.url, kind: u.kind })) };
  const evidence = items.map(i => ({ claim: `${i.kind}: ${i.title}${i.precision === "year" ? " (dated to the year only)" : ""}`, source_type: "web" as const, source_url: i.url, record_date: i.date, retrieved_at }));
  for (const u of undated) ctx.evidence("policy", { claim: `undated mention: ${u.title}`, source_type: "web", source_url: u.url, record_date: null, retrieved_at });
  for (const e of evidence) ctx.evidence("policy", e);
  ctx.log(`policy: ${flag}, ${items.length} dated items (${r.cached ? "memo" : `${r.credits} credits`})`);
  return { layer: "policy", status: "ok", data, evidence, credits: r.credits, latency_ms: r.latency_ms };
}
