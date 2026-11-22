/**
 *   npx tsx src/crm/demo.ts                      simulated HubSpot, no network
 *   npx tsx src/crm/demo.ts --zoho               simulated Zoho, which is coming soon (add --free for the Free edition)
 *   npx tsx src/crm/demo.ts [--zoho] --serve     the same, then the panel with two decisions waiting
 *   npx tsx src/crm/demo.ts --live              the real connected account, two example leads
 *   add --wait to --live to change the stage by hand in the CRM instead of by API
 */
import { existsSync } from "node:fs";
import type { Lead } from "../buyer/contract.js";
import { Ledger } from "../ledger/ledger.js";
import { KINDS, type AdapterFactory, type Kind, type Meter } from "./adapter.js";
import { Connections, usable } from "./credentials.js";
import { CrmSync, type SyncResult } from "./engine.js";
import { HubSpot } from "./hubspot.js";
import { TokenSource } from "./oauth.js";
import { serveCrm } from "./server.js";
import { startPolling } from "./router.js";
import { HubSpotSimulator } from "./simulator.js";
import { Zoho } from "./zoho.js";
import { ZohoSimulator } from "./zoho-simulator.js";

const flag = (name: string) => process.argv.includes(`--${name}`);
const live = flag("live"), zoho = flag("zoho"), name = zoho ? "Zoho" : "HubSpot";
if (existsSync(".env")) process.loadEnvFile(".env");

const lead = (key: string, company: string): Lead => ({
  lead_id: `meridian-demo-${key}`, client_id: "demo", run_id: "crm-demo", selected: true,
  company: { name: company, domain: `meridian-${key}.example.com`, country_iso3: "DEU", crustdata_company_id: null },
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
  const hsim = !live && !zoho ? new HubSpotSimulator() : null;
  const zsim = !live && zoho ? new ZohoSimulator(flag("free") ? "free" : "enterprise") : null;
  const http: typeof fetch = hsim?.fetch ?? zsim?.fetch ?? fetch;
  if (live && zoho) throw new Error("Zoho is coming soon; the live check is HubSpot only");
  let connections = new Connections();
  if (!live) {
    // the simulated run never reads or writes the real connections file
    const fake = { key: zoho ? "zoho" : "hubspot", provider: zoho ? "zoho" : "hubspot", client: "*", token: zoho ? undefined : "simulated", app_id: "simulated", app_secret: "simulated", refresh_token: "simulated", accounts_url: "https://accounts.zoho.in" } as any;
    connections = { get: () => fake, save: (_key: string, patch: object) => Object.assign(fake, patch) } as any;
  }
  const key = zoho ? "zoho" : "hubspot", saved = connections.get(key);
  if (!saved || !usable(saved)) throw new Error(`${name} is not connected. Run: npx tsx src/crm/connect.ts ${key}`);

  const tokens = new TokenSource(connections, key, http), gapMs = live ? undefined : 0;
  const factory: AdapterFactory = zoho ? (meter, state) => new Zoho(meter, { tokens, state, fetch: http, gapMs }) : meter => new HubSpot(meter, { tokens, fetch: http, gapMs });
  const ledger = new Ledger(live ? "data/crm-demo-live.db" : ":memory:");
  const crm = new CrmSync(ledger, factory);
  const run = `crm-demo-${Date.now()}`;
  console.log(live ? `LIVE ${name}` : `SIMULATED ${name}${flag("free") ? " Free edition" : ""} (real adapter, fake server, no network)`);

  // the demo's own view of the CRM, separate from the module it is checking
  const plain: Meter = (_endpoint, fn) => fn();
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const token = await tokens.get(plain), base = zoho ? `${tokens.connection().api_url}/crm/v8` : "https://api.hubapi.com";
    const r = await http(base + path, { method, headers: { authorization: `${zoho ? "Zoho-oauthtoken" : "Bearer"} ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`demo check: ${name} ${r.status} on ${method} ${path.split("?")[0]}`);
    return r.status === 204 ? null : r.json();
  };
  const census = async () => {
    const out: Record<string, number> = {};
    const sim = hsim ?? zsim;
    const path: Record<Kind, string> = zoho ? { company: "Accounts", contact: "Contacts", deal: "Deals" } : { company: "companies", contact: "contacts", deal: "deals" };
    for (const k of KINDS) {
      if (sim) { out[k] = sim.count(k); continue; }
      let after = "", n = 0;
      do {
        const d = await call("GET", zoho ? `/${path[k]}?fields=id&per_page=200${after}` : `/crm/v3/objects/${path[k]}?limit=100${after}`);
        n += (zoho ? d?.data : d?.results)?.length ?? 0;
        const next = zoho ? (d?.info?.more_records ? d.info.next_page_token : "") : d?.paging?.next?.after;
        after = next ? `&${zoho ? "page_token" : "after"}=${encodeURIComponent(next)}` : "";
      } while (after);
      out[k] = n;
    }
    return out;
  };
  const stages = async (): Promise<string[]> => {
    if (!zoho) return (await call("GET", "/crm/v3/pipelines/deals")).results[0].stages.map((s: any) => s.id);
    const layouts = (await call("GET", "/settings/layouts?module=Deals")).layouts, layout = layouts.find((l: any) => l.name === "Standard") ?? layouts[0];
    const fields = layout.sections.flatMap((s: any) => s.fields), field = fields.find((f: any) => f.api_name === "Stage");
    const list = fields.some((f: any) => f.api_name === "Pipeline") ? (await call("GET", `/settings/pipeline?layout_id=${layout.id}`))?.pipeline?.[0]?.maps ?? [] : field?.pick_list_values ?? [];
    return list.map((s: any) => s.actual_value).filter((v: string) => v && v !== "-None-");
  };
  const stageField = zoho ? "Stage" : "dealstage";

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
  const deal = crm.store.link(leads[0].lead_id, "deal")!, current = () => crm.crmOwned(leads[0].lead_id)[stageField];
  const old = current();
  if (live && flag("wait")) {
    console.log(`Move "DEMO Alpha Imports" to another stage in ${name} (waiting up to 2 minutes)`);
    for (let i = 0; i < 24 && current() === old; i++) { await new Promise(r => setTimeout(r, 5000)); await crm.pull(); }
  } else {
    // stands in for a salesperson: the sync module itself never writes a stage after create
    const next = (await stages()).find(s => s !== old)!;
    if (zoho) await call("PUT", "/Deals", { data: [{ id: deal.remote_id, Stage: next }], trigger: [] });
    else await call("PATCH", `/crm/v3/objects/deals/${deal.remote_id}`, { properties: { dealstage: next } });
    for (let i = 0; i < (live ? 5 : 1); i++) {
      await crm.pull();
      if (current() !== old) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const stage = current();
  check(!!stage && stage !== old, `stage change pulled back: ${old} -> ${stage}`);

  const again = await crm.pull();
  check(again.applied === 0 && !again.error, "the same change is not applied twice");

  await crm.push(run, leads);
  const onCrm = zoho ? (await call("GET", `/Deals/${deal.remote_id}`)).data[0].Stage : (await call("GET", `/crm/v3/objects/deals/${deal.remote_id}?properties=dealstage`)).properties.dealstage;
  check(onCrm === stage, "a later push leaves the CRM's stage alone");

  const sim = hsim ?? zsim;
  if (sim) {
    sim.set("company", crm.store.link(leads[0].lead_id, "company")!.remote_id, { [zoho ? "Account_Name" : "name"]: "DEMO Alpha Imports GmbH" });
    sim.remove("deal", crm.store.link(leads[1].lead_id, "deal")!.remote_id);
    await crm.pull();
    const r = await crm.push(run, leads);
    check(crm.status().conflicts.length === 2 && r.created === 0, "a CRM edit and a delete wait for a person");
  }
  if (!flag("serve")) return;
  // the panel drops its SIMULATED label only for a real account, and only after every check passed against it
  if (live && process.exitCode) { console.log("the live checks failed, so the live panel was not started"); return; }
  serveCrm(crm, { simulated: !!sim });
  if (live) startPolling(crm);
}

main().catch(e => { console.error(e?.message ?? e); process.exit(1); });
