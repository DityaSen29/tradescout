import { z } from "zod";
import type { StepCtx } from "../runner/pipeline.js";
import { askJson } from "../agents/llm.js";
import { MAX_CREDITS } from "../core/limits.js";
import { BudgetExceeded } from "../core/types.js";
import { and, f, flattenCompany } from "../sources/crustdata.js";
import { crust, SEARCH_FIELDS } from "../steps/common.js";
import { hashOf } from "../ledger/ledger.js";
import { newLead, quoteInSource, sameCompany, sourceAboutCompany, tracer, type Trace } from "./common.js";
import type { Claim, Lead } from "./contract.js";
import type { Plan } from "./plan.js";
import type { CustomsOutput } from "./customs.js";

export interface Source { id: string; kind: "company_record" | "web"; url: string | null; text: string; company: string | null; retrieved_at: string }
export interface Company { ref: string; id: string; name: string; domain: string | null }

const Action = z.object({
  thought: z.string(),
  tool: z.enum(["company_search", "web_search", "read_page", "company_lookup", "finish"]),
  query: z.string().nullish(),
  url: z.string().nullish(),
  domains: z.array(z.string()).nullish(),
  names: z.array(z.string()).nullish(),
  findings: z.array(z.object({ company: z.string(), source: z.string(), claim: z.string(), quote: z.string() })).max(30).nullish(),
});
const Verdicts = z.object({ verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(["accepted", "rejected"]), label: z.enum(["product_match", "category_match", "cannot_verify"]), reason: z.string() })) });

const TOOL_LIMIT = { company_search: 2, web_search: 5, read_page: 4, company_lookup: 3 };
const ROUNDS = [{ turns: 8, mustUse: 4 }, { turns: 6, mustUse: 2 }];

export function pageText(html: string, terms: string[]): string {
  const text = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  if (text.length <= 4000) return text;
  const low = text.toLowerCase();
  const at = terms.map(t => low.indexOf(t.toLowerCase())).filter(i => i >= 0);
  const from = Math.max(0, (at.length ? Math.min(...at) : 0) - 600);
  return text.slice(from, from + 4000);
}

export interface ResearchOutput { ran: boolean; leads: Lead[]; rejected: Claim[]; trace: Trace[]; stopped: string | null }

/** Researcher agent: chooses its own tools, reads what comes back, searches again. The critic sends it back once. */
export async function researchStep(ctx: StepCtx): Promise<ResearchOutput> {
  const { trace, say } = tracer(ctx);
  const plan = ctx.outputs.plan as Plan;
  const customs = ctx.outputs.customs as CustomsOutput;
  if (!customs.needs_research) { say("researcher", "Customs records already prove buyers. No research needed."); return { ran: false, leads: [], rejected: [], trace, stopped: null }; }

  const companies = new Map<string, Company>(), sources = new Map<string, Source>(), urls = new Set<string>();
  const accepted = new Map<string, { claims: Claim[]; label: "product_match" | "category_match"; reason: string }>();
  const rejected: Claim[] = [];
  const used = { company_search: 0, web_search: 0, read_page: 0, company_lookup: 0 };
  const history: unknown[] = [];
  let stopped: string | null = null;

  const addCompany = (id: string, name: string, domain: string | null) => {
    const found = [...companies.values()].find(c => c.id === id || (domain && c.domain === domain));
    if (found) return { c: found, fresh: false };
    const c = { ref: `C${companies.size + 1}`, id, name, domain };
    companies.set(c.ref, c);
    return { c, fresh: true };
  };
  const addSource = (s: Omit<Source, "id">) => { const id = `S${sources.size + 1}`; sources.set(id, { ...s, id }); return id; };

  async function useTool(a: z.infer<typeof Action>): Promise<unknown> {
    if (a.tool === "finish") return null;
    if (used[a.tool] >= TOOL_LIMIT[a.tool]) return { error: `${a.tool} limit reached, use another tool or finish` };
    if (a.tool === "company_search") {
      if (!a.query) return { error: "query is required" };
      used.company_search++;
      const limit = 10, query = a.query.slice(0, 200), iso = plan.country.iso3, min = ctx.request.min_headcount, max = ctx.request.max_headcount;
      // the market and size filters are set by code, the agent only chooses the words
      const r = await ctx.call({ source: "crustdata", endpoint: "/company/search", request: { query, iso, min, max, limit }, maxUnits: MAX_CREDITS.companySearch(limit), credits: (x: any) => x.credits }, async () => {
        const x = await crust().companySearch({ filters: and(f("locations.country", "=", iso), f("headcount.total", "=>", min), f("headcount.total", "=<", max)), fields: SEARCH_FIELDS, limit, query, mode: "hybrid" });
        return { companies: x.data.companies as any[], credits: x.credits };
      });
      const out = [];
      for (const raw of r.data.companies) {
        const x = flattenCompany(raw);
        if (!x.company_id || !x.name) continue;
        const { c, fresh } = addCompany(x.company_id, x.name, x.domain);
        if (!fresh) { out.push({ company: c.ref, already_seen: true }); continue; }
        const text = `${x.name}. ${(x.description ?? "").slice(0, 900)} Industries: ${x.industries.join(", ")}`;
        out.push({ company: c.ref, name: c.name, domain: c.domain, source: addSource({ kind: "company_record", url: null, text, company: c.ref, retrieved_at: r.retrieved_at }), text });
      }
      return out;
    }
    if (a.tool === "web_search") {
      if (!a.query) return { error: "query is required" };
      used.web_search++;
      const query = a.query.slice(0, 200);
      const r = await ctx.call({ source: "crustdata", endpoint: "/web/search/live", request: { query, sources: ["web"] }, maxUnits: MAX_CREDITS.webSearch(1), credits: (x: any) => x.credits }, async () => {
        const x = await crust().webSearch({ query, sources: ["web"], page: 1 });
        return { results: (x.data.results ?? []) as any[], credits: x.credits };
      });
      return r.data.results.slice(0, 8).map(it => {
        const text = `${it.title ?? ""}. ${it.snippet ?? ""}`;
        if (it.url) urls.add(it.url);
        return { source: addSource({ kind: "web", url: it.url ?? null, text, company: null, retrieved_at: r.retrieved_at }), url: it.url, text };
      });
    }
    if (a.tool === "read_page") {
      if (!a.url || !urls.has(a.url)) return { error: "read_page takes only a URL returned by web_search" };
      used.read_page++;
      const url = a.url;
      const r = await ctx.call({ source: "crustdata", endpoint: "/web/enrich/live", request: { url }, maxUnits: 1, credits: (x: any) => x.credits }, async () => {
        const x = await crust().webFetch([url]);
        const page = (x.data as any[])[0];
        return { text: page?.success ? pageText(String(page.content ?? ""), plan.include_terms) : "", credits: x.credits };
      });
      if (!r.data.text) return { error: "page could not be read" };
      return { source: addSource({ kind: "web", url, text: r.data.text, company: null, retrieved_at: r.retrieved_at }), url, text: r.data.text };
    }
    const domains = [...new Set((a.domains ?? []).map(d => d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase()).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 10);
    const names = domains.length ? [] : [...new Set((a.names ?? []).map(n => n.trim().slice(0, 100)).filter(n => n.length >= 4))].slice(0, 10);
    const keys = domains.length ? { domains } : { names };
    if (!domains.length && !names.length) return { error: "domains or names are required" };
    used.company_lookup++;
    const r = await ctx.call({ source: "crustdata", endpoint: "/company/identify", request: keys, maxUnits: (domains.length || names.length) * 0.2, credits: (x: any) => x.credits }, async () => {
      const x = await crust().companyIdentify(keys);
      return { items: x.data as any[], credits: x.credits };
    });
    return r.data.items.map(item => {
      const d = (domains.length ? item.matches?.slice(0, 1) : item.matches?.filter((m: any) => sameCompany(m.company_data?.basic_info?.name ?? "", item.matched_on)))?.[0]?.company_data;
      if (!d?.basic_info?.name) return { looked_up: item.matched_on, not_found: true };
      const { c } = addCompany(String(d.crustdata_company_id ?? d.basic_info.crustdata_company_id), d.basic_info.name, domains.length ? item.matched_on : d.basic_info.primary_domain ?? null);
      return { company: c.ref, name: c.name, domain: c.domain };
    });
  }

  for (let round = 0; round < ROUNDS.length; round++) {
    let findings: NonNullable<z.infer<typeof Action>["findings"]> = [];
    let toolsThisRound = 0;
    for (let turn = 0; turn < ROUNDS[round].turns; turn++) {
      const last = turn === ROUNDS[round].turns - 1 || stopped !== null;
      const a = await askJson(ctx, { agent: "researcher", schema: Action, maxOut: 3500,
        task: `You are the researcher. Find companies in the target market that buy, stock, install or specify this EXACT product, with a quote that proves it. There are no customs records for this market, so never say a company imports it.
Choose one tool per turn, read the result, and decide the next one:
- company_search {"query"}: Crustdata company search inside the market
- web_search {"query"}: live web search, best for proof about the exact product, projects, tenders and stockists
- read_page {"url"}: read a page returned by web_search
- company_lookup {"names":[]} or {"domains":[]}: turn companies found on the web into refs. A company needs a ref before it can be a finding
- finish {"findings":[{"company":"C1","source":"S3","claim":"what the source shows","quote":"8 to 30 words copied exactly from that source"}]}
A source can prove a claim about a company only if it is that company's own record or site, or it names the company. General trading in the category is weaker than the exact product. Skip the kinds listed as not_buyers: a search for suppliers of the product mostly returns its makers, who are the client's competitors. Look from the demand side: stockists and distributors who resell it, and the contractors, EPCs, fabricators and end users who name it in projects, tenders, catalogues and approved-vendor pages. Aim for five different companies, and read pages to get proof.
Return {"thought": one sentence of reasoning shown to the user, "tool": ..., plus that tool's fields}.`,
        data: { product: plan.product_spec, market: plan.country.name, include: plan.include_terms, exclude: plan.exclude_terms, buyer_types: plan.buyer_types, not_buyers: plan.not_buyers, suggested_search: plan.company_search,
          tool_calls_left: Object.fromEntries(Object.entries(TOOL_LIMIT).map(([k, v]) => [k, v - used[k as keyof typeof used]])), must_finish_now: last, history } });
      if (a.tool === "finish" && !last && toolsThisRound < ROUNDS[round].mustUse) {
        toolsThisRound++;       // counts, so a stubborn model cannot loop
        say("orchestrator", "Finish refused: the researcher has not looked far enough yet.");
        history.push({ orchestrator: "Too early to finish. Use a different tool or angle: search the web for a project, contractor, end user or stockist of this exact product, then read the best page." , turn });
        continue;
      }
      say("researcher", `${a.thought}${a.tool === "finish" ? "" : ` → ${a.tool}: ${a.query ?? a.url ?? [...(a.domains ?? []), ...(a.names ?? [])].join(", ")}`}`);
      if (a.tool === "finish" || last) { findings = a.findings ?? []; break; }
      let result: unknown;
      try { result = await useTool(a); }
      catch (err: any) {
        if (err instanceof BudgetExceeded) { if (err.what === "time") throw err; stopped = err.message; }
        result = { error: String(err?.message ?? err).slice(0, 160) };
        say("researcher", `${a.tool} failed: ${String(err?.message ?? err).slice(0, 120)}. Continuing without it.`);
      }
      toolsThisRound++;
      history.push({ tool: a.tool, query: a.query ?? a.url ?? a.domains ?? a.names, result });
    }

    // code first: known refs, a verbatim quote, and a source that is about this company
    const toCritic: { id: string; c: Company; src: Source; claim: string; quote: string }[] = [];
    const feedback: { company: string; reason: string }[] = [];
    const claimOf = (c: Company, text: string, quote: string, src: Source | undefined, id: string, verdict: Claim["verdict"], reason: string): Claim =>
      ({ id, lead_id: "", text: `${c.name}: ${text}`, kind: src?.kind ?? "web", quote, source_url: src?.url ?? null, record_id: src?.kind === "company_record" ? `crustdata/company/search:${c.id}` : null,
        retrieved_at: src?.retrieved_at ?? new Date().toISOString(), verdict, verdict_reason: reason, shareable: verdict === "accepted" });
    for (const x of findings) {
      const c = companies.get(x.company) ?? [...companies.values()].find(k => k.domain === x.company.toLowerCase() || sameCompany(k.name, x.company));
      const src = sources.get(x.source) ?? [...sources.values()].reverse().find(s => s.url === x.source)
        ?? [...sources.values()].find(s => quoteInSource(x.quote, s.text));      // the quote itself locates a mis-cited source
      if (!c) { say("critic", `Rejected ${x.company}: not resolved to a company record (code check)`); feedback.push({ company: x.company, reason: "unknown company ref, use company_lookup first" }); continue; }
      const id = hashOf([c.id, x.claim, x.quote]).slice(0, 10);
      const why = !src ? "unknown source" : !quoteInSource(x.quote, src.text) ? "the quote is not in the source"
        : (src.kind === "company_record" ? src.company !== c.ref : !sourceAboutCompany(src, c)) ? "the source is not about this company" : null;
      if (why) { rejected.push(claimOf(c, x.claim, x.quote, src, id, "rejected", why)); feedback.push({ company: c.ref, reason: why }); say("critic", `Rejected ${c.name}: ${why} (code check)`); continue; }
      toCritic.push({ id, c, src: src!, claim: x.claim, quote: x.quote });
    }
    if (toCritic.length) {
      const v = await askJson(ctx, { agent: "critic", schema: Verdicts, maxOut: 3000,
        task: `You are an adversarial evidence critic. You did not do this research. Try to refute each claim using only its source text.
Reject when the source doesn't support the claim, the company is one of not_buyers, or the product is one of the excluded ones.
Label product_match only when the source shows this exact product. Label category_match when it shows only the broader category. Return {"verdicts":[{"id","verdict":"accepted"|"rejected","label":"product_match"|"category_match"|"cannot_verify","reason": short}]} with one verdict per claim.`,
        data: { product: plan.product_spec, exclude: plan.exclude_terms, not_buyers: plan.not_buyers,
          claims: toCritic.map(t => { const at = t.src.text.toLowerCase().indexOf(t.quote.toLowerCase().slice(0, 30)); return { id: t.id, company: t.c.name, claim: t.claim, quote: t.quote, source_text: t.src.text.slice(Math.max(0, at - 700), Math.max(0, at - 700) + 1700) }; }) } });
      for (const t of toCritic) {
        const j = v.verdicts.find(x => x.id === t.id);
        const ok = j?.verdict === "accepted" && j.label !== "cannot_verify";
        const cl = claimOf(t.c, t.claim, t.quote, t.src, t.id, ok ? "accepted" : "rejected", j?.reason ?? "the critic gave no verdict");
        if (!ok) { rejected.push(cl); feedback.push({ company: t.c.ref, reason: cl.verdict_reason }); say("critic", `Rejected ${t.c.name}: ${cl.verdict_reason}`); continue; }
        const label = j!.label as "product_match" | "category_match";
        const cur = accepted.get(t.c.ref) ?? { claims: [], label, reason: cl.verdict_reason };
        if (label === "product_match" && cur.label !== label) { cur.label = label; cur.reason = cl.verdict_reason; }
        if (!cur.claims.some(c => c.id === cl.id)) cur.claims.push(cl);
        accepted.set(t.c.ref, cur);
        say("critic", `Accepted ${t.c.name} as ${label}: ${cl.verdict_reason}`);
      }
    }
    const strong = [...accepted.values()].filter(a => a.label === "product_match").length;
    if (strong >= 3 || round === ROUNDS.length - 1 || stopped) break;
    say("critic", `Only ${strong} exact-product match(es). Sending the researcher back.`);
    history.push({ critic_feedback: feedback, accepted: [...accepted].map(([company, a]) => ({ company, label: a.label })), instruction: "Find stronger proof of the exact product, or other companies. Don't repeat searches." });
  }

  const leads: Lead[] = [];
  for (const c of companies.values()) {
    const a = accepted.get(c.ref);
    const match = a?.label ?? "cannot_verify";
    const lead = newLead(ctx, { name: c.name, domain: c.domain, iso3: plan.country.iso3, id: c.id, hs: plan.hs.map(h => h.code), match,
      reason: a?.reason ?? "no claim survived the critic",
      score: (match === "product_match" ? 70 : match === "category_match" ? 40 : 10) + Math.min(20, (a?.claims.length ?? 0) * 7), claims: a?.claims });
    for (const cl of lead.claims) cl.lead_id = lead.lead_id;
    if (match !== "cannot_verify") lead.needs_person.push("no shipment records for this market: product use is evidenced, importing is not");
    if (!leads.some(l => l.lead_id === lead.lead_id)) leads.push(lead);
  }
  for (const l of leads) for (const c of l.claims)
    ctx.evidence(l.lead_id, { claim: c.text, source_type: c.kind === "company_record" ? "crustdata" : "web", source_url: c.source_url ?? "https://api.crustdata.com/company/search", record_id: c.record_id ?? undefined, field: c.quote, record_date: null, retrieved_at: c.retrieved_at });
  leads.sort((a, b) => b.fit_score - a.fit_score);
  return { ran: true, leads, rejected, trace, stopped };
}
