import type { Ledger } from "../ledger/ledger.js";
import type { Lead } from "../buyer/contract.js";
import type { AdapterFactory } from "./adapter.js";
import { CrmSync, type SyncResult } from "./engine.js";
import { HubSpot } from "./hubspot.js";

export { CrmSync, type SyncResult } from "./engine.js";
export { HubSpot } from "./hubspot.js";
export { Zoho } from "./zoho.js";
export { createCrmRouter, startPolling } from "./router.js";

const instances = new WeakMap<Ledger, CrmSync>();
/** The one HubSpot sync for this ledger. */
export function crmFor(ledger: Ledger): CrmSync {
  let crm = instances.get(ledger);
  if (!crm) instances.set(ledger, (crm = new CrmSync(ledger, meter => new HubSpot(meter))));
  return crm;
}

/** The integrator's entry point. It never throws for a CRM outage: those leads stay queued and count as errors. */
export function syncLeads(ledger: Ledger, runId: string, leads: Lead[], factory?: AdapterFactory): Promise<SyncResult> {
  return (factory ? new CrmSync(ledger, factory) : crmFor(ledger)).push(runId, leads);
}
