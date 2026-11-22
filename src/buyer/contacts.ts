import { z } from "zod";
import type { StepCtx } from "../runner/pipeline.js";
import { askJson } from "../agents/llm.js";
import type { Plan } from "./plan.js";
import { BudgetExceeded } from "../core/types.js";
import { MAX_CREDITS } from "../core/limits.js";
import { and, f, or, flattenCompany, flattenPerson } from "../sources/crustdata.js";
import { crust, iso3Of, BUYING_TITLE } from "../steps/common.js";
import { hashOf } from "../ledger/ledger.js";
import type { EmailStatus, Lead } from "./contract.js";
import { tracer, type Trace } from "./common.js";

const LEGAL = /\b(s\.?a\.?s?\.?|c\.?a\.?|c[ií]a|compa[nñ][ií]a|ltda|limitada|an[oó]nima|l\.?l\.?c\.?|inc|ltd|limited|corp|corporation|co|fze|fzco|fzc|pvt|private|gmbh|s\.?r\.?l|de|del|la|el|the|and|usa)\b\.?/gi;
const words = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/flavour/g, "flavor").replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w.length > 1);
const COMMON = new Set("american national international global united universal general natural pacific premier royal first north south east west eastern western central new star golden".split(" "));
/**
 * The exact phrase to search for: the first distinctive word, or the first two words when the first is short or common.
 * The fuzzy operator is not used: it reads "Mane" as "Made" and "Lane".
 */
export function searchName(name: string): string {
  const w = name.toLowerCase().replace(/[.,()]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (w.length < 2) return w.join(" ");
  // a second word only when it distinguishes and has one spelling
  return words(w[1]).length && (w[0].length < 5 || COMMON.has(w[0]) || !/^flavou?rs?$/.test(w[1])) ? `${w[0]} ${w[1]}` : w[0];
}
/** Dice over the distinctive words of two company names. */
export function nameMatch(a: string, b: string, market = ""): number {
  const skip = new Set(words(market));       // "Acme Ecuador" is ACME in Ecuador
  const keep = (s: string) => new Set(words(s).filter(w => !skip.has(w)));
  const x = keep(a), y = keep(b);
  if (!x.size || !y.size) return 0;
  const both = [...x].filter(w => y.has(w)).length;
  // the whole record name inside a longer registered name is a candidate: the identity critic decides
  return both === y.size ? Math.max(0.8, (2 * both) / (x.size + y.size)) : (2 * both) / (x.size + y.size);
}

const Identity = z.object({ picks: z.array(z.object({ key: z.string(), company_id: z.string().nullable(), reason: z.string() })) });
const MGMT = /\b(managing|gerente|propietario|presidente|jefe de (importaciones|log[ií]stica)|partner|procurement manager|ceo|chief executive|owner|founder|president|coo|chief operating|general manager|operations|project|commercial director|director)\w*/i;
const NEVER = /\b(hr|human resources|marketing|finance|accountant|legal|software|talent|recruit)\w*/i;
export function titleScore(title: string): number {
  if (BUYING_TITLE.test(title)) return 3;
  return MGMT.test(title) && !NEVER.test(title) ? 2 : 0;
}

/** Runs only on the companies a person selected. */
export async function contactsStep(ctx: StepCtx): Promise<{ leads: Lead[]; trace: Trace[] }> {
  const { trace, say } = tracer(ctx);
  const plan = ctx.outputs.plan as Plan;
  const market = plan.country.name;
  const leads: Lead[] = structuredClone((ctx.outputs.select as { leads: Lead[] }).leads);
  if (!leads.length) return { leads, trace };

  const unresolved = leads.filter(x => !x.company.crustdata_company_id);
  if (unresolved.length) {
    // names on export records are resolved inside the market: a namesake in another country is not the importer
    const iso = unresolved[0].company.country_iso3;
    const names = [...new Set(unresolved.map(l => searchName(l.company.name)).filter(n => n.length >= 3))];
    const limit = 25;
    if (names.length) try {
      const found: ReturnType<typeof flattenCompany>[] = [];
      // one search per name: a shared search lets one common word crowd the others out of the result
      const searches = await Promise.allSettled(names.map(async name => {
      const r = await ctx.call({ source: "crustdata", endpoint: "/company/search", request: { iso, name, limit, about: plan.company_search }, maxUnits: limit * 0.03, credits: (x: any) => x.credits }, async () => {
        const x = await crust().companySearch({ filters: and(f("locations.country", "=", iso), f("basic_info.name", "[.]", name)), query: plan.company_search, mode: "hybrid", fields: ["basic_info.name", "basic_info.primary_domain", "basic_info.description", "crustdata_company_id"], limit });
        return { companies: x.data.companies as any[], credits: x.credits };
      });
        return r.data.companies;
      }));
      // every search has settled before anything can fail the step, so a resume never repeats a paid call still in flight
      for (const [i, r] of searches.entries()) {
        if (r.status === "fulfilled") found.push(...r.value.map(flattenCompany).filter(c => c.name && c.company_id));
        else if (r.reason instanceof BudgetExceeded) throw r.reason;
        else say("enrichment", `Lookup of "${names[i]}" failed (${String(r.reason?.message ?? r.reason).slice(0, 80)}). The other names continue.`);
      }
      const namesakes = unresolved.map((l, i) => ({ key: `K${i + 1}`, l,
        options: found.map(c => ({ c, s: nameMatch(c.name!, l.company.name, market) })).filter(x => x.s >= 0.8).sort((x, y) => y.s - x.s).slice(0, 5) }));
      const toJudge = namesakes.filter(n => n.options.length);
      // the same name is not the same company: a hair brand can share the name of a flavour house
      const verdicts = !toJudge.length ? [] : (await askJson(ctx, { agent: "identity-critic", schema: Identity, maxOut: 1500,
        task: `You are the identity critic. Each group lists companies that share a name with a buyer of the product. Pick the one whose own business could plausibly buy this product in industrial or wholesale quantity. Pick null when none plausibly could, when a record says too little to tell, or when it is merely a consumer brand with a matching name. A wrong pick emails a stranger: when in doubt, null. Return {"picks":[{"key","company_id":string or null,"reason": short}]}.`,
        data: { product: plan.product_spec, buyer_types: plan.buyer_types, end_uses: plan.end_uses,
          groups: toJudge.map(n => ({ key: n.key, candidates: n.options.map(({ c }) => ({ company_id: c.company_id, name: c.name, industries: c.industries, description: (c.description ?? "").slice(0, 600) })) })) } })).picks;
      for (const { key, l, options } of namesakes) {
        const pick = verdicts.find(v => v.key === key);
        const m = options.find(o => o.c.company_id === pick?.company_id);
        if (options.length && !m) {
          l.needs_person.push(`identity not confirmed: ${pick?.reason ?? "the identity critic gave no verdict"}`);
          say("critic", `${l.company.name}: same name, not shown to be the same company. ${pick?.reason ?? ""}`);
          continue;
        }
        if (!m) { l.needs_person.push("no confident Crustdata match in this country for the name on the record"); say("enrichment", `${l.company.name}: no confident company match, left for a person`); continue; }
        l.company.crustdata_company_id = m.c.company_id;
        l.company.domain = m.c.domain;
        say("enrichment", `${l.company.name}: matched to ${m.c.name}`);
      }
    } catch (err: any) {
      if (err instanceof BudgetExceeded || err?.name === "LlmError") throw err;
      for (const l of unresolved) l.needs_person.push(`company lookup unavailable: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  const ids = [...new Set(leads.flatMap(l => (l.company.crustdata_company_id ? [Number(l.company.crustdata_company_id)] : [])))];
  if (!ids.length) { say("enrichment", "No selected company could be matched in Crustdata."); return { leads, trace }; }

  const en = await ctx.call({ source: "crustdata", endpoint: "/company/enrich", request: { ids }, maxUnits: MAX_CREDITS.companyEnrich(ids.length), credits: (x: any) => x.credits }, async () => {
    const x = await crust().companyEnrich({ ids, fields: ["basic_info", "locations"] });
    return { items: (Array.isArray(x.data) ? x.data : x.data.companies ?? x.data.items) as any[], credits: x.credits };
  });
  const confirmed: Lead[] = [];
  for (const l of leads) {
    if (!l.company.crustdata_company_id) continue;
    const rec = en.data.items.map(it => flattenCompany(it.matches?.[0]?.company_data ?? it)).find(c => c.company_id === l.company.crustdata_company_id);
    if (!rec) { l.needs_person.push("cannot verify: no enrichment record"); continue; }
    const iso = iso3Of(rec.country);
    if (iso !== l.company.country_iso3) { l.needs_person.push(`identity not confirmed: the matched company is in ${iso ?? "an unknown country"}, so no person was looked up`); continue; }
    if (rec.description) {
      const quote = rec.description.slice(0, 450);
      l.claims.push({ id: hashOf([l.lead_id, "record"]).slice(0, 10), lead_id: l.lead_id, text: `${l.company.name} describes itself: ${quote}`, kind: "company_record", quote,
        source_url: null, record_id: `crustdata/company/enrich:${rec.company_id}`, retrieved_at: en.retrieved_at, verdict: "accepted", verdict_reason: "the company's own record", shareable: true });
    }
    confirmed.push(l);
  }
  if (!confirmed.length) return { leads, trace };

  const cids = confirmed.map(l => Number(l.company.crustdata_company_id));
  const limit = Math.min(50, cids.length * 10);
  const fields = ["basic_profile.name", "basic_profile.location.country", "experience.employment_details.current.title", "experience.employment_details.current.name",
    "experience.employment_details.current.crustdata_company_id", "contact.has_business_email", "social_handles.professional_network_identifier.profile_url", "crustdata_person_id"];
  const ps = await ctx.call({ source: "crustdata", endpoint: "/person/search", request: { cids, fields, limit }, maxUnits: MAX_CREDITS.personSearch(limit), credits: (x: any) => x.credits }, async () => {
    const x = await crust().personSearch({ filters: and(f("experience.employment_details.current.company_id", "in", cids), or(
      f("experience.employment_details.current.title", "(.)", "procurement purchasing purchase sourcing buyer supply chain import compras importaciones gerente owner founder general manager"),
      f("experience.employment_details.current.seniority_level", "in", ["Director", "Vice President", "CXO", "Owner / Partner", "Experienced Manager"]))), fields, limit });
    return { profiles: x.data.profiles as any[], credits: x.credits };
  });
  const urlOf = new Map<string, string>();
  for (const l of confirmed) {
    const best = ps.data.profiles.flatMap(raw => {
      const p = flattenPerson(raw);
      return p.positions.filter(pos => pos.company_id === l.company.crustdata_company_id).map(pos => {
        const role = titleScore(pos.title ?? "");
        return { p, pos, raw, score: role && role * 4 + (iso3Of(p.country) === l.company.country_iso3 ? 2 : 0) + (raw.contact?.has_business_email ? 1 : 0) };
      });
    }).filter(x => x.score > 0 && x.p.name).sort((a, b) => b.score - a.score)[0];
    if (!best) { l.needs_person.push("no purchasing or management contact found"); say("enrichment", `${l.company.name}: no decision-maker found`); continue; }
    l.contact = { person_id: best.p.person_id || hashOf([best.p.name, l.lead_id]).slice(0, 12), name: best.p.name, title: best.pos.title ?? "", email: null, email_status: "not_found" };
    const url = best.raw.social_handles?.professional_network_identifier?.profile_url;
    if (url && best.raw.contact?.has_business_email !== false) urlOf.set(l.lead_id, url);
    else l.needs_person.push("Crustdata has no work email for this person, so none was bought");
    say("enrichment", `${l.company.name}: decision-maker is the ${l.contact.title}`);
  }
  if (urlOf.size) {
    const urls = [...urlOf.values()];
    try {
      const pe = await ctx.call({ source: "crustdata", endpoint: "/person/enrich", request: { urls }, maxUnits: MAX_CREDITS.personEnrichWorkEmail(urls.length), credits: (x: any) => x.credits }, async () => {
        const x = await crust().personEnrich(urls);
        return { items: x.data as any[], credits: x.credits };
      });
      for (const l of confirmed) {
        const url = urlOf.get(l.lead_id);
        if (!url || !l.contact) continue;
        const d = pe.data.items.find(i => i.matched_on === url)?.matches?.[0]?.person_data;
        // only an address at this employer: an old job's mailbox is the wrong person to write to
        const e = (d?.contact?.business_emails ?? []).find((e: any) => e.email && ((e.crustdata_company_id != null && String(e.crustdata_company_id) === l.company.crustdata_company_id)
          || (l.company.domain && e.email.toLowerCase().endsWith(`@${l.company.domain.toLowerCase()}`))));
        if (!e) { l.needs_person.push("no work email at this company"); continue; }
        l.contact.email = e.email;
        l.contact.email_status = (["deliverable", "catch_all", "invalid"].includes(e.status) ? e.status : "unknown") as EmailStatus;
        if (l.contact.email_status !== "deliverable") l.needs_person.push(`work email is ${l.contact.email_status}: verify before sending`);
      }
      say("enrichment", `${confirmed.filter(l => l.contact?.email).length} work email(s) found for ${confirmed.length} companies`);
    } catch (err: any) {
      if (err instanceof BudgetExceeded) throw err;
      say("enrichment", "Work-email lookup is unavailable. Drafts will have no address.");
    }
  }
  return { leads, trace };
}
