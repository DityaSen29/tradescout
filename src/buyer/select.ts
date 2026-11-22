import type { StepCtx } from "../runner/pipeline.js";
import { NeedsPerson } from "../core/types.js";
import type { Lead } from "./contract.js";
import type { CustomsOutput } from "./customs.js";
import type { ResearchOutput } from "./research.js";
import { sameCompany, tracer, type Trace } from "./common.js";

/** The client's customers, agents and distributors, by name or domain. */
export function onDoNotContact(c: { name: string; domain: string | null }, list: string[]): boolean {
  return list.map(x => x.trim()).filter(Boolean).some(x => sameCompany(c.name, x) || (!!c.domain && x.replace(/^(https?:\/\/)?(www\.)?/, "").split("/")[0].toLowerCase() === c.domain.toLowerCase()));
}

export const MAX_SELECTED = 5;
const ORDER = { import_record: 0, product_match: 1, category_match: 2, cannot_verify: 3 };

/** Both routes merged into one ranked shortlist. Free: nothing is enriched before a person selects. */
export async function shortlistStep(ctx: StepCtx): Promise<{ leads: Lead[]; trace: Trace[] }> {
  const { trace, say } = tracer(ctx);
  const byId = new Map<string, Lead>();
  for (const src of [(ctx.outputs.research as ResearchOutput).leads, (ctx.outputs.customs as CustomsOutput).leads]) {
    for (const raw of src) {
      const l: Lead = structuredClone(raw);
      const had = byId.get(l.lead_id);
      if (had) {       // found on both routes: the record proves the import, the web gives shareable proof
        l.claims.push(...had.claims);
        l.company.domain ??= had.company.domain;
        l.company.crustdata_company_id ??= had.company.crustdata_company_id;
        if (ORDER[had.match] < ORDER[l.match]) { l.match = had.match; l.match_reason = had.match_reason; }
        l.fit_score = Math.min(100, Math.max(l.fit_score, had.fit_score) + 10);
      }
      byId.set(l.lead_id, l);
    }
  }
  const blocked = ctx.request.do_not_contact ?? [];
  const kept = [...byId.values()].filter(l => !onDoNotContact(l.company, blocked));
  if (kept.length < byId.size) say("policy", `${byId.size - kept.length} company(ies) removed: on your don't-contact list`);
  const leads = kept.sort((a, b) => ORDER[a.match] - ORDER[b.match] || b.fit_score - a.fit_score).slice(0, 25);
  if (!leads.length) throw new Error("cannot verify request: neither the export files nor research produced a company with a record");
  say("orchestrator", `Shortlist ready: ${leads.length} companies. Paid enrichment waits for your selection.`);
  return { leads, trace };
}

export async function selectStep(ctx: StepCtx): Promise<{ leads: Lead[] }> {
  const picked = ctx.ledger.getSelection(ctx.runId);
  if (!picked) throw new NeedsPerson(`select up to ${MAX_SELECTED} companies for enrichment and outreach`);
  const all = (ctx.outputs.shortlist as { leads: Lead[] }).leads;
  return { leads: all.filter(l => picked.includes(l.lead_id)).map(l => ({ ...l, selected: true })) };
}
