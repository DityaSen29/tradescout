import type { StepCtx } from "../runner/pipeline.js";
import { and, f, or, flattenPerson } from "../sources/crustdata.js";
import { crust, apiEvidence, BUYING_TITLE, iso3Of } from "./common.js";
import type { VetOutput } from "./vet.js";

/**
 * Step: find one procurement decision-maker per vetted GREEN/AMBER candidate.
 * Personal data is minimised: name, title, company and profile URL only. No emails, no phones, no enrichment.
 */
export async function contactsStep(ctx: StepCtx): Promise<{ found: number; notes: string[] }> {
  const vet = ctx.outputs.vet as VetOutput;
  const targets = vet.candidates.filter(c => c.trust_tier !== "RED" && vet.enriched_ids.includes(c.company_id));
  const ids = targets.map(c => Number(c.company_id)).filter(Number.isFinite);
  const notes: string[] = [];
  if (!ids.length) return { found: 0, notes: ["no vetted candidates to contact"] };
  const fields = ["basic_profile.name", "basic_profile.headline", "basic_profile.location.country", "basic_profile.professional_network_name", "experience.employment_details.current.title", "experience.employment_details.current.name", "experience.employment_details.current.crustdata_company_id", "experience.employment_details.current.seniority_level"];
  const r = await ctx.call({ source: "crustdata", endpoint: "/person/search", request: { ids, fields, limit: 15 }, credits: (x: any) => x.credits }, async () => {
    const x = await crust().personSearch({
      filters: and(f("experience.employment_details.current.company_id", "in", ids), or(
        f("experience.employment_details.current.title", "(.)", "procurement purchasing sourcing buyer supply chain category import"),
        f("experience.employment_details.current.seniority_level", "in", ["Director", "Vice President", "CXO", "Owner / Partner", "Experienced Manager"]))),
      fields, limit: 15,
    });
    return { profiles: x.data.profiles ?? [], credits: x.credits, retrieved_at: x.retrieved_at };
  });
  const retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
  const MGMT = /\b(managing|gesch[aä]ftsf[uü]hr|ceo|chief executive|owner|inhaber|president|coo|chief operating|general manager|supply|operations|einkauf|commercial director)\w*/i;
  const NOT_BUYER = /\b(sales|customer service|marketing|engineering|hr|human|finance|controller|it\b|software|legal|quality)\w*/i;
  let found = 0;
  for (const c of targets) {
    const people = (r.data.profiles as any[]).map(flattenPerson).flatMap(person => person.positions.filter(pos => pos.company_id === c.company_id).map(pos => ({ person, pos })))
      .map(({ person, pos }) => {
        const t = pos.title ?? "";
        let score = BUYING_TITLE.test(t) ? 3 : MGMT.test(t) ? 2 : 0;
        if (score && NOT_BUYER.test(t) && !BUYING_TITLE.test(t)) score = 0;
        if (score && iso3Of(person.country) === c.country) score += 1;
        return { person, pos, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    const best = people[0];
    if (!best) { c.unresolved.push("no procurement or management contact found in person search; " + ((r.data.profiles as any[]).some(p => flattenPerson(p).positions.some(pos => pos.company_id === c.company_id)) ? "only sales/support titles returned" : "no people returned for this company")); continue; }
    c.contact = { name: best.person.name, title: best.pos.title ?? best.person.headline ?? "", company: best.pos.company ?? c.name, linkedin: null };
    const e = apiEvidence(`${best.person.name} is ${best.pos.title ?? "a decision-maker"} at ${c.name} (seniority ${best.pos.seniority ?? "n/a"})`, "/person/search", best.person.person_id || best.person.name, "experience.employment_details.current.title", retrieved_at, null, ctx.runId);
    c.evidence.push(e); ctx.evidence(c.company_id, e); found++;
  }
  ctx.log(`contacts: ${found}/${targets.length} (${r.cached ? "memo" : `${r.credits} credits`})`);
  return { found, notes };
}
