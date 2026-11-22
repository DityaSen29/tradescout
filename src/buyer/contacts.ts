import type { StepCtx } from "../runner/pipeline.js";
import { BudgetExceeded } from "../core/types.js";
import { MAX_CREDITS } from "../core/limits.js";
import { and, f, or, flattenCompany, flattenPerson } from "../sources/crustdata.js";
import { crust, iso3Of, BUYING_TITLE } from "../steps/common.js";
import { hashOf } from "../ledger/ledger.js";
import type { EmailStatus, Lead } from "./contract.js";
import { tracer, type Trace } from "./common.js";

const LEGAL = /\b(s\.?a\.?s?\.?|c\.?a\.?|c[ií]a|compa[nñ][ií]a|ltda|limitada|an[oó]nima|l\.?l\.?c\.?|inc|ltd|limited|corp|corporation|co|fze|fzco|fzc|pvt|private|gmbh|s\.?r\.?l|de|del|la|el|the)\b\.?/gi;
const words = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(LEGAL, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w.length > 1);
/** The words of a record name worth searching on. */
export const searchName = (name: string) => words(name).slice(0, 4).join(" ");
/** Dice over the distinctive words of two company names. */
export function nameMatch(a: string, b: string, market = ""): number {
  const skip = new Set(words(market));       // "Ambacar Ecuador" is AMBACAR in Ecuador
  const keep = (s: string) => new Set(words(s).filter(w => !skip.has(w)));
  const x = keep(a), y = keep(b);
  if (!x.size || !y.size) return 0;
  return (2 * [...x].filter(w => y.has(w)).length) / (x.size + y.size);
}

const MGMT = /\b(managing|gerente|propietario|presidente|jefe de (importaciones|log[ií]stica)|partner|procurement manager|ceo|chief executive|owner|founder|president|coo|chief operating|general manager|operations|project|commercial director|director)\w*/i;
const NEVER = /\b(hr|human resources|marketing|finance|accountant|legal|software|talent|recruit)\w*/i;
export function titleScore(title: string): number {
  if (BUYING_TITLE.test(title)) return 3;
  return MGMT.test(title) && !NEVER.test(title) ? 2 : 0;
}

/** Runs only on the companies a person selected. */
export async function contactsStep(ctx: StepCtx): Promise<{ leads: Lead[]; trace: Trace[] }> {
  const { trace, say } = tracer(ctx);
  const market: string = (ctx.outputs.plan as any).country.name;
  const leads: Lead[] = structuredClone((ctx.outputs.select as { leads: Lead[] }).leads);
  if (!leads.length) return { leads, trace };

  const unresolved = leads.filter(x => !x.company.crustdata_company_id);
  if (unresolved.length) {
    // names on export records are resolved inside the market: a namesake in another country is not the importer
    const iso = unresolved[0].company.country_iso3;
    const names = [...new Set(unresolved.map(l => searchName(l.company.name)).filter(n => n.length >= 3))];
    const limit = 50;
    if (names.length) try {
      const r = await ctx.call({ source: "crustdata", endpoint: "/company/search", request: { iso, names, limit }, maxUnits: limit * 0.03, credits: (x: any) => x.credits }, async () => {
        const byName = names.map(n => f("basic_info.name", "(.)", n));
        const x = await crust().companySearch({ filters: and(f("locations.country", "=", iso), byName.length > 1 ? or(...byName) : byName[0]), fields: ["basic_info.name", "basic_info.primary_domain", "crustdata_company_id"], limit });
        return { companies: x.data.companies as any[], credits: x.credits };
      });
      const found = r.data.companies.map(flattenCompany).filter(c => c.name && c.company_id);
      for (const l of unresolved) {
        const m = found.map(c => ({ c, s: nameMatch(c.name!, l.company.name, market) })).filter(x => x.s >= 0.8).sort((x, y) => y.s - x.s)[0];
        if (!m) { l.needs_person.push("no confident Crustdata match in this country for the name on the record"); say("enrichment", `${l.company.name}: no confident company match, left for a person`); continue; }
        l.company.crustdata_company_id = m.c.company_id;
        l.company.domain = m.c.domain;
        say("enrichment", `${l.company.name}: matched to ${m.c.name}`);
      }
    } catch (err: any) {
      if (err instanceof BudgetExceeded) throw err;
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
