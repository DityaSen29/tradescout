/**
 *   npx tsx src/crm/demo.ts            simulated HubSpot, no network
 *   npx tsx src/crm/demo.ts --serve    the same, then the panel with two decisions waiting
 *   npx tsx src/crm/demo.ts --live     a real HubSpot account (HUBSPOT_TOKEN), two example leads
 *   add --wait to --live to change the stage by hand in HubSpot instead of by API
 */
import { existsSync } from "node:fs";
import type { Lead } from "../buyer/contract.js";
import { Ledger } from "../ledger/ledger.js";
import { KINDS, type Kind } from "./adapter.js";
import { CrmSync, type SyncResult } from "./engine.js";
import { HubSpot } from "./hubspot.js";
import { HubSpotSimulator } from "./simulator.js";
import { serveCrm } from "./server.js";

const flag = (name: string) => process.argv.includes(`--${name}`);
const live = flag("live");
if (existsSync(".env")) process.loadEnvFile(".env");

const lead = (key: string, name: string): Lead => ({
  lead_id: `meridian-demo-${key}`, client_id: "demo", run_id: "crm-demo", selected: true,
  company: { name, domain: `meridian-${key}.example.com`, country_iso3: "DEU", crustdata_company_id: null },
  product: "example product", hs_codes: [], match: "product_match", match_reason: "example", fit_score: 80, behaviour: null, claims: [], needs_person: [],
  contact: { person_id: key, name: `Demo ${key[0].toUpperCase()}${key.slice(1)}`, title: "Purchasing Manager", email: `buyer@meridian-${key}.example.com`, email_status: "deliverable" },
});
const leads = [lead("alpha", "DEMO Alpha Imports"), lead("beta", "DEMO Beta Trading")];

function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
}
const show = (label: string, r: SyncResult) =>
  console.log(`${label}: created ${r.created}, updated ${r.updated}, skipped ${r.skipped}, errors ${r.errors}${r.errors ? ` (${r.details.map(d => d.message).filter(Boolean).join("; ")})` : ""}`);

async function main() {
  if (live && !process.env.HUBSPOT_TOKEN) throw new Error("HUBSPOT_TOKEN is not set");
  const sim = live ? null : new HubSpotSimulator();
  const http = sim?.fetch ?? fetch;
  const token = live ? process.env.HUBSPOT_TOKEN! : "simulated";
  const ledger = new Ledger(live ? "data/crm-demo-live.db" : ":memory:");
  const crm = new CrmSync(ledger, meter => new HubSpot(meter, { token, fetch: http, gapMs: live ? 120 : 0 }));
  const run = `crm-demo-${Date.now()}`;
  console.log(live ? "LIVE HubSpot" : "SIMULATED HubSpot (real adapter, fake server, no network)");

  // the demo's own view of the CRM, separate from the module it is checking
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await http(`https://api.hubapi.com${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`demo check: HubSpot ${r.status} on ${method} ${path.split("?")[0]}`);
    return r.json() as Promise<any>;
  };
  const census = async () => {
    if (sim) return Object.fromEntries(KINDS.map(k => [k, sim.count(k)]));
    const path: Record<Kind, string> = { company: "companies", contact: "contacts", deal: "deals" }, out: Record<string, number> = {};
    for (const k of KINDS) {
      let after = "", n = 0;
      do {
        const d = await call("GET", `/crm/v3/objects/${path[k]}?limit=100${after}`);
        n += d.results.length;
        after = d.paging?.next?.after ? `&after=${encodeURIComponent(d.paging.next.after)}` : "";
      } while (after);
      out[k] = n;
    }
    return out;
  };

  const first = await crm.push(run, leads);
  show("push 1", first);
  if (first.errors) throw new Error("first push failed; stopping");
  const before = await census();
  console.log("records:", JSON.stringify(before));

  const second = await crm.push(run, leads);
  show("push 2", second);
  check(second.created === 0 && second.errors === 0, "the second push creates nothing");
  const after = await census();
  check(JSON.stringify(before) === JSON.stringify(after), `record counts unchanged ${JSON.stringify(after)}`);

  await crm.pull();
  const deal = crm.store.link(leads[0].lead_id, "deal")!;
  const old = crm.crmOwned(leads[0].lead_id).dealstage;
  if (live && flag("wait")) {
    console.log(`Move "DEMO Alpha Imports" to another stage in HubSpot (waiting up to 2 minutes)`);
    for (let i = 0; i < 24 && crm.crmOwned(leads[0].lead_id).dealstage === old; i++) { await new Promise(r => setTimeout(r, 5000)); await crm.pull(); }
  } else {
    // stands in for a salesperson: the sync module itself never writes a stage after create
    const stages: { id: string }[] = (await call("GET", "/crm/v3/pipelines/deals")).results[0].stages;
    await call("PATCH", `/crm/v3/objects/deals/${deal.remote_id}`, { properties: { dealstage: stages.find(s => s.id !== old)!.id } });
    for (let i = 0; i < (live ? 5 : 1); i++) {
      await crm.pull();
      if (crm.crmOwned(leads[0].lead_id).dealstage !== old) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const stage = crm.crmOwned(leads[0].lead_id).dealstage;
  check(!!stage && stage !== old, `stage change pulled back: ${old} -> ${stage}`);

  const again = await crm.pull();
  check(again.applied === 0 && !again.error, "the same change is not applied twice");

  await crm.push(run, leads);
  const onCrm = (await call("GET", `/crm/v3/objects/deals/${deal.remote_id}?properties=dealstage`)).properties.dealstage;
  check(onCrm === stage, "a later push leaves the CRM's stage alone");

  if (sim) {
    sim.set("company", crm.store.link(leads[0].lead_id, "company")!.remote_id, { name: "DEMO Alpha Imports GmbH" });
    sim.remove("deal", crm.store.link(leads[1].lead_id, "deal")!.remote_id);
    await crm.pull();
    const r = await crm.push(run, leads);
    check(crm.status().conflicts.length === 2 && r.created === 0, "a CRM edit and a delete wait for a person");
  }
  if (flag("serve")) serveCrm(crm, { simulated: !!sim });
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
