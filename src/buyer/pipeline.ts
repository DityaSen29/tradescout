import type { StepCtx, StepDef } from "../runner/pipeline.js";
import { planStep } from "./plan.js";
import { customsStep } from "./customs.js";
import { researchStep } from "./research.js";
import { shortlistStep, selectStep } from "./select.js";
import { contactsStep } from "./contacts.js";
import { writeStep } from "./write.js";
import type { Trace } from "./common.js";
import type { Lead } from "./contract.js";

async function reportStep(ctx: StepCtx) {
  const o = ctx.outputs as any;
  const selected = new Map<string, Lead>((o.contacts.leads as Lead[]).map(l => [l.lead_id, l]));
  const leads = (o.shortlist.leads as Lead[]).map(l => selected.get(l.lead_id) ?? l);
  const trace: Trace[] = ["plan", "customs", "research", "shortlist", "contacts", "write"].flatMap(s => o[s]?.trace ?? []);
  return {
    run_id: ctx.runId, request: ctx.request, route: o.research.ran ? (o.customs.coverage === "records" ? "customs+research" : "research") : "customs",
    leads, rejected_claims: o.research.rejected, blocked_drafts: o.write.blocked, trace,
    actions: ctx.ledger.listActions(ctx.runId), ledger: ctx.ledger.totals(ctx.runId),
  };
}

/** The orchestrator is code: agents think inside a step, code owns order, money, state and actions. */
export function buildBuyerPipeline(): StepDef[] {
  return [
    { name: "plan", run: planStep },
    { name: "customs", run: customsStep },
    { name: "research", run: researchStep },
    { name: "shortlist", run: shortlistStep },
    { name: "select", run: selectStep },
    { name: "contacts", run: contactsStep },
    { name: "write", run: writeStep },
    { name: "report", run: reportStep },
  ];
}
