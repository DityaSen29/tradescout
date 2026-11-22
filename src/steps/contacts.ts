import type { StepCtx } from "../runner/pipeline.js";
import { and, f, or, flattenPerson } from "../sources/crustdata.js";
import { crust, apiEvidence, BUYING_TITLE } from "./common.js";
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
  const fields = ["basic_profile.name", "basic_profile.headline", "basic_profile.location.country", "experience.employment_details.current.title", "experience.employment_details.current.company_name", "experience.employment_details.current.company_id", "basic_info.professional_network_url"];
  const r = await ctx.call({ source: "crustdata", endpoint: "/person/search", request: { ids, fields, limit: 15 }, credits: (x: any) => x.credits }, async () => {
    const x = await crust().personSearch({
      filters: and(f("experience.employment_details.current.company_id", "in", ids), or(
        f("experience.employment_details.current.title", "(.)", "procurement purchasing sourcing buyer supply chain category import"),
        f("experience.employment_details.current.seniority_level", "in", ["Director", "VP", "C-Level", "Owner", "Partner"]))),
      fields, limit: 15,
    });
    return { profiles: x.data.profiles ?? [], credits: x.credits, retrieved_at: x.retrieved_at };
  });
  const retrieved_at = r.data.retrieved_at ?? r.retrieved_at;
  let found = 0;
  for (const c of targets) {
    const people = (r.data.profiles as any[]).map(flattenPerson).filter(p => String(p.company_id ?? "") === c.company_id && p.name);
    people.sort((a, b) => Number(BUYING_TITLE.test(b.title ?? "")) - Number(BUYING_TITLE.test(a.title ?? "")));
    const p = people[0];
    if (!p) { c.unresolved.push("no procurement contact found in person search"); continue; }
    c.contact = { name: p.name, title: p.title ?? p.headline ?? "", company: p.company ?? c.name, linkedin: p.linkedin };
    const e = apiEvidence(`${p.name} is ${p.title ?? "a decision-maker"} at ${c.name}`, "/person/search", p.person_id || p.name, "experience.employment_details.current.title", retrieved_at);
    c.evidence.push(e); ctx.evidence(c.company_id, e); found++;
  }
  ctx.log(`contacts: ${found}/${targets.length} (${r.cached ? "memo" : `${r.credits} credits`})`);
  return { found, notes };
}
