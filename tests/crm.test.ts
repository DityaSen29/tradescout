import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.js";
import type { Lead } from "../src/buyer/contract.js";
import { CrmSync } from "../src/crm/engine.js";
import { HubSpot } from "../src/crm/hubspot.js";
import { Zoho } from "../src/crm/zoho.js";
import { Connections } from "../src/crm/credentials.js";
import { TokenSource } from "../src/crm/oauth.js";
import { HubSpotSimulator } from "../src/crm/simulator.js";
import { createCrmRouter, validSignature } from "../src/crm/router.js";
import { syncLeads } from "../src/crm/index.js";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const lead = (id = "a", over: Partial<Lead> = {}): Lead => ({
  lead_id: id, client_id: "c", run_id: "r", selected: true, product: "SECRET-PRODUCT", hs_codes: ["731431"], match: "import_record",
  match_reason: "SECRET-REASON", fit_score: 90, needs_person: [],
  company: { name: `Company ${id}`, domain: `${id}.example.com`, country_iso3: "DEU", crustdata_company_id: null },
  behaviour: { records: 4, months_active: 3, first_month: "2026-01", last_month: "2026-09", median_gap_months: 2, next_window: null, total_value_usd: 987654321, total_quantity: 1, net_weight_kg: 1, median_usd_per_kg: 1, supplier_count: 1, top_suppliers: [{ name: "SECRET-SUPPLIER", share: 1 }], origins: ["IN"] },
  claims: [{ id: "k", lead_id: id, text: "SECRET-CLAIM", kind: "customs", quote: "SECRET-QUOTE", source_url: null, record_id: null, retrieved_at: "", verdict: "accepted", verdict_reason: "", shareable: false }],
  contact: { person_id: id, name: "Test Buyer", title: "Buyer", email: `buyer@${id}.example.com`, email_status: "deliverable" },
  ...over,
});
function setup(ledger = new Ledger(":memory:"), sim = new HubSpotSimulator()) {
  const factory = (meter: any) => new HubSpot(meter, { token: "test", fetch: sim.fetch, gapMs: 0 });
  const crm = new CrmSync(ledger, factory);
  const id = (kind: "company" | "contact" | "deal", key = "a") => crm.store.link(key, kind)!.remote_id;
  const counts = () => [sim.count("company"), sim.count("contact"), sim.count("deal")];
  return { ledger, sim, crm, id, counts, factory };
}

describe("push: no duplicates", () => {
  it("pushing twice creates one of each", async () => {
    const t = setup();
    expect(await t.crm.push("r", [lead()])).toMatchObject({ created: 1, errors: 0 });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: 0 });
    expect(t.counts()).toEqual([1, 1, 1]);
  });
  it.each(["companies", "contacts", "deals"])("a lost answer after creating %s does not create a second one", async (path) => {
    const t = setup();
    t.sim.fail.push({ match: new RegExp(`^POST /crm/v3/objects/${path}$`), status: 503, after: true });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    t.crm.store.requeueFailed(); await t.crm.drain();
    expect(t.counts()).toEqual([1, 1, 1]);
  });
  it("a lost local database relinks by external id", async () => {
    const a = setup(); await a.crm.push("r", [lead()]);
    const b = setup(new Ledger(":memory:"), a.sim); await b.crm.push("r", [lead()]);
    expect(b.counts()).toEqual([1, 1, 1]);
  });
  it("two workers on one ledger file write once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-")), file = join(dir, "l.db");
    try {
      const a = setup(new Ledger(file)), b = setup(new Ledger(file), a.sim);
      await Promise.all([a.crm.push("r", [lead()]), b.crm.push("r", [lead()])]);
      expect(a.counts()).toEqual([1, 1, 1]);
      a.ledger.db.close(); b.ledger.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("finishes a job a dead worker left in flight", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.crm.store.requeue("a"); expect(t.crm.store.claim()).not.toBeNull();
    await t.crm.drain();
    expect(t.crm.store.outbox()[0].state).toBe("done"); expect(t.counts()).toEqual([1, 1, 1]);
  });
  it("two leads at one company share its record", async () => {
    const t = setup(), b = lead("b"); b.company = { ...lead().company };
    await t.crm.push("r", [lead(), b]);
    expect(t.counts()).toEqual([1, 2, 2]);
  });
  it("updates a changed field in place", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    expect(await t.crm.push("r", [lead("a", { match: "product_match" })])).toMatchObject({ updated: 1, created: 0 });
    expect(t.sim.rows.deal.get(t.id("deal"))!.props.meridian_match).toBe("product_match");
  });
  it("a blank field does not erase the CRM", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    await t.crm.push("r", [lead("a", { contact: null, company: { ...lead().company, domain: null } })]);
    expect(t.sim.rows.company.get(t.id("company"))!.props.domain).toBe("a.example.com");
    expect(t.counts()).toEqual([1, 1, 1]);
  });
});

describe("what leaves this machine", () => {
  it("only selected leads, and no customs, claims, reasons or product", async () => {
    const t = setup();
    expect(await t.crm.push("r", [lead(), lead("no", { selected: false })])).toMatchObject({ created: 1, skipped: 1 });
    const sent = JSON.stringify(t.sim.requests);
    expect(sent).not.toMatch(/SECRET|987654321|731431|Company no/);
  });
  it.each(["invalid", "not_found"] as const)("withholds a %s email", async (email_status) => {
    const t = setup(); await t.crm.push("r", [lead("a", { contact: { ...lead().contact!, email_status } })]);
    expect(t.sim.rows.contact.get(t.id("contact"))!.props.email).toBeUndefined();
  });
  it.each(["", "..", "has space", "x/y", null])("refuses lead id %j", async (id) => {
    const t = setup();
    expect(await t.crm.push("r", [{ ...lead(), lead_id: id as string }])).toMatchObject({ errors: 1, created: 0 });
    expect(t.counts()).toEqual([0, 0, 0]);
  });
  it("refuses the same lead id from another client", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    expect(await t.crm.push("r", [lead("a", { client_id: "other" })])).toMatchObject({ errors: 1 });
  });
  it("keeps emails and bodies out of the call ledger", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    const rows = t.ledger.db.prepare("SELECT * FROM calls").all();
    expect(rows.length).toBeGreaterThan(5); expect(JSON.stringify(rows)).not.toContain("buyer@");
  });
});

describe("pull and field ownership", () => {
  it("pulls stage, owner and amount once, and never writes them back", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("deal", t.id("deal"), { dealstage: "qualifiedtobuy", hubspot_owner_id: "7", amount: "500" });
    expect((await t.crm.pull()).applied).toBeGreaterThan(0);
    expect(t.crm.crmOwned("a")).toMatchObject({ dealstage: "qualifiedtobuy", hubspot_owner_id: "7", amount: "500" });
    expect((await t.crm.pull()).applied).toBe(0);
    await t.crm.push("r", [lead("a", { match: "product_match" })]);
    for (const r of t.sim.requests.filter(r => r.method === "PATCH"))
      expect(Object.keys(r.body.properties)).not.toEqual(expect.arrayContaining([expect.stringMatching(/dealstage|owner|amount/)]));
    expect(t.sim.rows.deal.get(t.id("deal"))!.props.dealstage).toBe("qualifiedtobuy");
  });
  it("applies a webhook once and ignores an older one", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    const e = (value: string, at: number) => ({ subscriptionType: "deal.propertyChange", objectId: t.id("deal"), propertyName: "dealstage", propertyValue: value, occurredAt: at });
    expect(t.crm.ingest([e("closedwon", 2000), e("closedwon", 2000)]).applied).toBe(1);
    expect(t.crm.ingest([e("qualifiedtobuy", 1000)]).applied).toBe(0);
    expect(t.crm.crmOwned("a").dealstage).toBe("closedwon");
  });
  it("a CRM edit of our field waits, then keeps the CRM's", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { name: "Edited" });
    await t.crm.pull();
    await t.crm.decide(t.crm.status().conflicts[0].id, "rejected"); await t.crm.drain();
    expect(t.sim.rows.company.get(t.id("company"))!.props.name).toBe("Edited");
    expect(t.crm.status().conflicts).toHaveLength(0);
  });
  it("or overwrites it when a person says so", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { name: "Edited" });
    await t.crm.push("r", [lead()]);
    expect(t.sim.rows.company.get(t.id("company"))!.props.name).toBe("Edited");
    await t.crm.decide(t.crm.status().conflicts[0].id, "approved"); await t.crm.drain();
    expect(t.sim.rows.company.get(t.id("company"))!.props.name).toBe("Company a");
  });
  it("an edit that was undone needs no decision", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { name: "Edited" }); await t.crm.pull();
    t.sim.set("company", t.id("company"), { name: "Company a" }); await t.crm.pull();
    expect(t.crm.status().conflicts).toHaveLength(0);
  });
});

describe("a person approves what cannot be undone", () => {
  it("does not recreate a deleted deal until told to", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.remove("deal", t.id("deal"));
    await t.crm.push("r", [lead()]);
    expect(t.sim.count("deal")).toBe(0);
    await t.crm.decide(t.crm.status().conflicts[0].id, "rejected"); await t.crm.drain();
    expect(t.sim.count("deal")).toBe(1);
  });
  it("accepting a delete stops syncing it", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.remove("deal", t.id("deal")); await t.crm.pull();
    await t.crm.decide(t.crm.status().conflicts[0].id, "approved"); await t.crm.push("r", [lead()]);
    expect(t.sim.count("deal")).toBe(0);
  });
  it("follows a merge only after approval", async () => {
    const t = setup(); await t.crm.push("r", [lead(), lead("b")]);
    const old = t.id("company", "b"), winner = t.id("company");
    t.sim.merge("company", old, winner); await t.crm.pull();
    expect(t.id("company", "b")).toBe(old);
    expect(t.crm.status().conflicts).toMatchObject([{ type: "merge", theirs: winner }]);
    await t.crm.decide(t.crm.status().conflicts[0].id, "approved"); await t.crm.drain();
    expect(t.id("company", "b")).toBe(winner);
    expect(t.sim.rows.company.get(winner)!.props.name).toBe("Company a");
  });
  it("links an existing company only after approval, without overwriting it", async () => {
    const t = setup(), existing = t.sim.seed("company", { name: "Human's name", domain: "a.example.com" });
    await t.crm.push("r", [lead()]);
    expect(t.sim.count("company")).toBe(1); expect(t.crm.store.link("a", "company")).toBeNull();
    await t.crm.decide(t.crm.status().conflicts[0].id, "approved"); await t.crm.drain();
    expect(existing.props).toMatchObject({ name: "Human's name", meridian_lead_id: "a" });
  });
  it("does not replace the contact person silently", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    await t.crm.push("r", [lead("a", { contact: { ...lead().contact!, name: "New Person", email: "new@a.example.com" } })]);
    const contact = t.sim.rows.contact.get(t.id("contact"))!;
    expect(contact.props.firstname).toBe("Test");
    await t.crm.decide(t.crm.status().conflicts[0].id, "approved"); await t.crm.drain();
    expect(contact.props.firstname).toBe("New");
  });
  it("will not apply a stale decision", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { name: "One" }); await t.crm.pull();
    const shown = t.crm.status().conflicts[0].id;
    t.sim.set("company", t.id("company"), { name: "Two" }); await t.crm.pull();
    await expect(t.crm.decide(shown, "approved")).rejects.toThrow(/changed/);
  });
});

describe("failures and caps", () => {
  it.each([429, 500, 503])("%s retries from the outbox", async (status) => {
    const t = setup();
    t.sim.fail.push({ match: /^POST \/crm\/v3\/objects\/deals$/, status });
    await t.crm.push("r", [lead()]);
    expect(t.crm.store.outbox()[0].state).toBe("retry");
    t.crm.store.requeueFailed(); await t.crm.drain();
    expect(t.counts()).toEqual([1, 1, 1]);
  });
  it("a 400 is not retried", async () => {
    const t = setup();
    t.sim.fail.push({ match: /^POST \/crm\/v3\/objects\/deals$/, status: 400 });
    await t.crm.push("r", [lead()]);
    expect(t.crm.store.outbox()[0].state).toBe("failed");
  });
  it.each(["CRM_RUN_CALL_LIMIT", "CRM_DAILY_CALL_LIMIT"])("%s stops calls and keeps the queue", async (name) => {
    vi.stubEnv(name, "3");
    const t = setup();
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    expect(t.sim.requests).toHaveLength(3); expect(t.crm.store.outbox()[0].state).toBe("pending");
  });
  it("a rejected key keeps the queue", async () => {
    const t = setup();
    t.sim.fail.push({ match: /account-info/, status: 401 });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    expect(t.crm.status()).toMatchObject({ connected: false }); expect(t.crm.store.outbox()[0].state).toBe("pending");
  });
  it("refuses a different CRM account", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.portal = 2;
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    expect((await t.crm.pull()).error).toMatch(/linked to CRM account/);
  });
  it("an unreachable CRM is never read as everything deleted", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.fail.push({ match: /batch\/read/, status: 503 });
    expect(await t.crm.pull()).toMatchObject({ conflicts: 0, error: expect.stringMatching(/503/) });
  });
  it("Zoho without a sign-in says so and sends nothing", async () => {
    const http = vi.fn(), dir = mkdtempSync(join(tmpdir(), "crm-"));
    try {
      const tokens = new TokenSource(new Connections(join(dir, "c.json"), ["zoho"]), "zoho", http as any);
      const r = await syncLeads(new Ledger(":memory:"), "r", [lead()], (m, state) => new Zoho(m, { tokens, state, fetch: http as any }));
      expect(r).toMatchObject({ created: 0, errors: 1 }); expect(r.details[0].message).toMatch(/not connected/);
      expect(http).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the HTTP surface", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); });
  it("serves the panel locally, refuses other origins, hosts and unsigned webhooks", async () => {
    const route = createCrmRouter(setup().crm, { simulated: true });
    server = createServer(async (q, r) => { if (!(await route(q, r))) { r.writeHead(404); r.end(); } });
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port, base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/crm`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/crm/connection`)).json()).toMatchObject({ state: "unchecked", open_conflicts: 0 });
    expect(await (await fetch(`${base}/api/crm/connect`, { method: "POST" })).json()).toMatchObject({ state: "connected" });
    expect(await (await fetch(`${base}/api/crm/sync`, { method: "POST" })).json()).toMatchObject({ applied: 0, error: null });
    expect(await (await fetch(`${base}/api/crm/conflicts`)).json()).toEqual({ conflicts: [] });
    expect(await (await fetch(`${base}/api/crm/leads`)).json()).toEqual({ leads: [] });
    expect((await fetch(`${base}/api/crm/sync`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    const rebound = await new Promise<number>(r => request({ host: "127.0.0.1", port, path: "/crm", headers: { host: "evil.example" } }, res => { res.resume(); r(res.statusCode!); }).end());
    expect(rebound).toBe(403);
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "s"); vi.stubEnv("HUBSPOT_WEBHOOK_URL", "https://hook.example/x");
    expect((await fetch(`${base}/api/crm/webhook/hubspot`, { method: "POST", body: "[]" })).status).toBe(401);
  });
  it("gives a UI the wording, the choices, and a 409 on a stale decision", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { name: "Edited" }); await t.crm.pull();
    const route = createCrmRouter(t.crm, { simulated: true });
    server = createServer(async (q, r) => { await route(q, r); });
    await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/crm/conflicts`;
    const [c] = ((await (await fetch(base)).json()) as any).conflicts;
    expect(c).toMatchObject({ type: "field", needs_confirmation: false, choices: { approve: "Use Meridian's" } });
    expect((await fetch(`${base}/${c.id}/reject`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/${c.id}/reject`, { method: "POST" })).status).toBe(409);
  });
  it("checks signature and age", () => {
    const now = 1_800_000_000_000, uri = "https://hook.example/x", sig = createHmac("sha256", "s").update(`POST${uri}[]${now}`).digest("base64");
    expect(validSignature("s", uri, "[]", sig, String(now), now)).toBe(true);
    expect(validSignature("s", uri, "[1]", sig, String(now), now)).toBe(false);
    expect(validSignature("s", uri, "[]", sig, String(now), now + 300_001)).toBe(false);
  });
});
