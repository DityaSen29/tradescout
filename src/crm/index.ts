import type { Ledger } from "../ledger/ledger.js";
import type { Lead } from "../buyer/contract.js";
import type { AdapterFactory } from "./adapter.js";
import { CrmSync, type SyncResult } from "./engine.js";
import { CrmHub } from "./hub.js";

export { CrmSync, type SyncResult } from "./engine.js";
export { CrmHub } from "./hub.js";
export { HubSpot } from "./hubspot.js";
export { Zoho } from "./zoho.js";
export { createCrmRouter, startPolling } from "./router.js";

const hubs = new WeakMap<Ledger, CrmHub>();
/** Every CRM connection for this ledger: HubSpot, Zoho, one per client. */
export function crmFor(ledger: Ledger): CrmHub {
  let hub = hubs.get(ledger);
  if (!hub) hubs.set(ledger, (hub = new CrmHub(ledger)));
  return hub;
}

/** The integrator's entry point. It never throws for a CRM outage: those leads stay queued and count as errors. */
export function syncLeads(ledger: Ledger, runId: string, leads: Lead[], factory?: AdapterFactory): Promise<SyncResult> {
  return factory ? new CrmSync(ledger, factory).push(runId, leads) : crmFor(ledger).push(runId, leads);
}
