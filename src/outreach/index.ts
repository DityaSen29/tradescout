import type { Ledger } from "../ledger/ledger.js";
import { Outreach, type OutreachOptions, type SendResult } from "./engine.js";

export { checkDomain, dailyCap } from "./deliverability.js";
export { classifyReply } from "./classify.js";
export { Outreach } from "./engine.js";
export { outreachRoutes, startWorker } from "./routes.js";

/** The executor for an approved email_draft. Every check, then ledger.executeAction. */
export function executeDraft(ledger: Ledger, actionId: string, opts: OutreachOptions = {}): Promise<SendResult> {
  return new Outreach(ledger, opts).execute(actionId);
}
