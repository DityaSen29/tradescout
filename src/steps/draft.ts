import type { StepCtx } from "../runner/pipeline.js";
import type { ProposedAction } from "../core/types.js";
import type { VetOutput } from "./vet.js";

/** Step: draft the first email per contacted candidate as a proposed action. Nothing is sent; a person approves or rejects. Deterministic template, no model memory. */
export async function draftStep(ctx: StepCtx): Promise<{ actions: ProposedAction[] }> {
  const vet = ctx.outputs.vet as VetOutput;
  const parse = ctx.outputs.parse as any;
  const actions: ProposedAction[] = [];
  for (const c of vet.candidates.filter(c => c.contact && c.trust_tier !== "RED")) {
    const signal = c.intent_tags[0] ? ` We noticed ${c.intent_tags[0]}.` : "";
    const body = `Dear ${c.contact!.name},\n\nI run exports of ${ctx.request.product} (HS ${parse.hs.best?.code ?? ""}) from India and am looking for a distribution partner in ${parse.country?.name ?? c.country}. ${c.name} came up as a ${c.fit_reasons[0] ?? "relevant counterparty"}.${signal}\n\nWould you be open to a 20-minute call next week to see whether our range fits your portfolio? I can share specifications, certifications and indicative FOB pricing beforehand.\n\nBest regards,\n[Your name]\n[Company]`;
    const a = ctx.ledger.proposeAction(ctx.runId, "email_draft", `draft:${ctx.runId}:${c.company_id}`, {
      to_name: c.contact!.name, to_title: c.contact!.title, company: c.name, company_id: c.company_id, subject: `Distribution partnership for ${ctx.request.product} in ${parse.country?.name ?? c.country}`, body,
      based_on: c.evidence.slice(0, 3).map(e => e.source_url),
    });
    actions.push(a);
  }
  if (vet.candidates.some(c => c.trust_tier !== "RED")) {
    actions.push(ctx.ledger.proposeAction(ctx.runId, "shortlist_file", `shortlist:${ctx.runId}`, { format: "json", path: `data/out/shortlist-${ctx.runId}.json` }));
  }
  ctx.log(`draft: ${actions.length} actions proposed, awaiting approval`);
  return { actions };
}
