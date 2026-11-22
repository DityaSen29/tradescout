import type { StepDef } from "./runner/pipeline.js";
import { parseRequest } from "./semantics/parse.js";
import { searchStep } from "./steps/search.js";
import { vetStep } from "./steps/vet.js";
import { intentStep } from "./steps/intent.js";
import { contactsStep } from "./steps/contacts.js";
import { draftStep } from "./steps/draft.js";
import { reportStep } from "./steps/report.js";
import { marketStep } from "./layers/market.js";
import { tariffStep } from "./layers/tariff.js";
import { policyStep } from "./layers/policy.js";

/**
 * The TradeScout pipeline. Each step is a checkpoint in the ledger.
 * parse → search → vet → intent (optional) → contacts → draft → report
 * Market, tariff and policy layers slot in after parse as optional steps.
 */
export function buildPipeline(): StepDef[] {
  return [
    {
      name: "parse",
      run: async (ctx) => {
        const r = parseRequest(ctx.request);
        for (const e of r.evidence) ctx.evidence("request", e);
        if (r.status === "cannot_verify") throw new Error(`cannot verify request: ${r.questions.join(" ")}`);
        if (r.status === "needs_input") throw new Error(`needs input: ${r.questions.join(" ")} Re-run with hs_code set to one of ${r.hs.candidates.slice(0, 3).map(c => c.code).join(", ")}.`);
        return r;
      },
    },
    { name: "market", run: marketStep, optional: true },
    { name: "tariff", run: tariffStep, optional: true },
    { name: "policy", run: policyStep, optional: true },
    { name: "search", run: searchStep },
    { name: "vet", run: vetStep },
    { name: "intent", run: intentStep, optional: true },
    { name: "contacts", run: contactsStep, optional: true },
    { name: "draft", run: draftStep },
    { name: "report", run: reportStep },
  ];
}
