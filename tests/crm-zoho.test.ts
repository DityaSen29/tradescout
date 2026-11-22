import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.js";
import type { Lead } from "../src/buyer/contract.js";
import { connectionView } from "../src/crm/api.js";
import { Connections } from "../src/crm/credentials.js";
import { CrmSync } from "../src/crm/engine.js";
import { CrmHub } from "../src/crm/hub.js";
import { HubSpot } from "../src/crm/hubspot.js";
import { TokenSource, ZOHO_SCOPES } from "../src/crm/oauth.js";
import { createCrmRouter, startPolling } from "../src/crm/router.js";
import { HubSpotSimulator } from "../src/crm/simulator.js";
import { Zoho, readLine, writeLines } from "../src/crm/zoho.js";
import { ZohoSimulator } from "../src/crm/zoho-simulator.js";

const BOTH = ["hubspot", "zoho"] as const;
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "crm-")); dirs.push(d); return join(d, "crm.json"); };
const clearEnv = () => { for (const k of ["HUBSPOT_TOKEN", "HUBSPOT_CLIENT_SECRET", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "CRM_PROVIDER"]) vi.stubEnv(k, ""); };

const lead = (id = "a", over: Partial<Lead> = {}): Lead => ({
  lead_id: id, client_id: "c", run_id: "r", selected: true, product: "SECRET-PRODUCT", hs_codes: ["731431"], match: "product_match",
  match_reason: "SECRET-REASON", fit_score: 90, behaviour: null, needs_person: [],
  claims: [{ id: "k", lead_id: id, text: "SECRET-CLAIM", kind: "customs", quote: "SECRET-QUOTE", source_url: null, record_id: null, retrieved_at: "", verdict: "accepted", verdict_reason: "", shareable: false }],
  company: { name: `Company ${id}`, domain: `${id}.example.com`, country_iso3: "DEU", crustdata_company_id: null },
  contact: { person_id: id, name: "Test Buyer", title: "Buyer", email: `buyer@${id}.example.com`, email_status: "deliverable" },
  ...over,
});

function setup(edition: "free" | "enterprise" = "enterprise", sim = new ZohoSimulator(edition), ledger = new Ledger(":memory:"), path = file(), notifyUrl?: string) {
  clearEnv();
  const connections = new Connections(path, BOTH);
  connections.save("zoho", { provider: "zoho", client: "*", app_id: "id", app_secret: "secret", refresh_token: "refresh", accounts_url: "https://accounts.zoho.in", hook_secret: "hook" });
  const crm = new CrmSync(ledger, (meter, state) => new Zoho(meter, { tokens: new TokenSource(connections, "zoho", sim.fetch), state, fetch: sim.fetch, gapMs: 0, notifyUrl }));
  const id = (kind: "company" | "contact" | "deal", key = "a") => crm.store.link(key, kind)!.remote_id;
  const counts = () => [sim.count("company"), sim.count("contact"), sim.count("deal")];
  const value = (kind: "company" | "contact" | "deal", field: string, key = "a") => {
    const props = sim.rows[kind].get(id(kind, key))!.props;
    return edition === "free" && field.startsWith("Meridian_") ? readLine(props.Description ?? "", field) : props[field];
  };
  const decide = async (decision: "approved" | "rejected") => { await crm.decide(crm.status().conflicts[0].id, decision); await crm.drain(); };
  return { sim, ledger, crm, connections, path, id, counts, value, decide };
}

describe.each(["enterprise", "free"] as const)("Zoho %s edition", (edition) => {
  it("pushing twice creates one of each and links them", async () => {
    const t = setup(edition);
    expect(await t.crm.push("r", [lead()])).toMatchObject({ created: 1, errors: 0 });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ created: 0, updated: 0, skipped: 1, errors: 0 });
    expect(t.counts()).toEqual([1, 1, 1]);
    expect(t.value("deal", "Meridian_Lead_Id")).toBe("a");
    expect(t.value("deal", "Meridian_Match")).toBe("product_match");
    expect(t.sim.rows.deal.get(t.id("deal"))!.props).toMatchObject({ Stage: "Qualification", Pipeline: "Standard (Standard)", Account_Name: { id: t.id("company") }, Contact_Name: { id: t.id("contact") } });
    expect(t.crm.status().storage).toBe(edition === "free" ? "description" : "fields");
  });
  it.each(["Accounts", "Contacts", "Deals"])("a lost answer after creating %s does not create a second one", async (module) => {
    const t = setup(edition);
    t.sim.fail.push({ match: new RegExp(`^POST /crm/v8/${module}$`), status: 503, after: true });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    t.crm.store.requeueFailed(); await t.crm.drain();
    expect(t.counts()).toEqual([1, 1, 1]);
  });
  it("a lost local database relinks by external id", async () => {
    const a = setup(edition); await a.crm.push("r", [lead()]);
    const b = setup(edition, a.sim); expect(await b.crm.push("r", [lead()])).toMatchObject({ created: 0, errors: 0 });
    expect(b.counts()).toEqual([1, 1, 1]);
  });
  it("updates our field in place", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    expect(await t.crm.push("r", [lead("a", { match: "category_match" })])).toMatchObject({ updated: 1 });
    expect(t.value("deal", "Meridian_Match")).toBe("category_match");
  });
  it("pulls stage, owner and amount once and never writes them back", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]); await t.crm.pull();
    t.sim.set("deal", t.id("deal"), { Stage: "Closed Won", Owner: { id: "7", name: "Asha" }, Amount: 500 });
    expect((await t.crm.pull()).applied).toBeGreaterThan(0);
    expect(t.crm.crmOwned("a")).toMatchObject({ Stage: "Closed Won", Owner: "Asha", Amount: "500" });
    expect(t.crm.status().leads[0].crm_fields).toMatchObject({ stage: "Closed Won", owner: "Asha", amount: "500" });
    expect((await t.crm.pull()).applied).toBe(0);
    await t.crm.push("r", [lead("a", { match: "category_match" })]);
    for (const r of t.sim.requests.filter(r => r.method === "PUT"))
      for (const row of r.body.data) expect(Object.keys(row).filter(k => ["Stage", "Pipeline", "Owner", "Amount"].includes(k))).toEqual([]);
    expect(t.sim.rows.deal.get(t.id("deal"))!.props.Stage).toBe("Closed Won");
  });
  it("applies the current value when history is cut short", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]); await t.crm.pull();
    t.sim.set("deal", t.id("deal"), { Stage: "Needs Analysis" });
    t.sim.rows.deal.get(t.id("deal"))!.timeline = [];
    await t.crm.pull();
    expect(t.crm.crmOwned("a").Stage).toBe("Needs Analysis");
  });
  it("a CRM edit of our field waits", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    t.sim.set("company", t.id("company"), { Account_Name: "Edited" });
    await t.crm.push("r", [lead()]);
    expect(t.value("company", "Account_Name")).toBe("Edited");
    await t.decide("approved");
    expect(t.value("company", "Account_Name")).toBe("Company a");
  });
  it("does not recreate a deleted deal until told to", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    t.sim.remove("deal", t.id("deal")); await t.crm.push("r", [lead()]);
    expect(t.sim.count("deal")).toBe(0);
    await t.decide("rejected");
    expect(t.sim.count("deal")).toBe(1);
  });
  it("an accepted delete can be resumed after a restore", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    const id = t.id("deal"), row = t.sim.rows.deal.get(id)!;
    t.sim.remove("deal", id); await t.crm.pull(); await t.decide("approved");
    expect(t.crm.status().paused).toHaveLength(1);
    t.sim.rows.deal.set(id, row);
    expect(await t.crm.resume("a", "deal")).toBe("linked");
    await t.crm.drain();
    expect(t.sim.count("deal")).toBe(1); expect(t.id("deal")).toBe(id);
  });
  it("offers a merged contact as a possible merge", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    const winner = t.sim.seed("contact", { Last_Name: "Human's copy", Email: "buyer@a.example.com" }).id;
    t.sim.merge("contact", t.id("contact"), winner); await t.crm.pull();
    expect(t.crm.status().conflicts).toMatchObject([{ type: "merge", ours: "possible", theirs: winner }]);
    await t.decide("approved");
    expect(t.id("contact")).toBe(winner);
    expect(t.value("contact", "Last_Name")).toBe("Human's copy");
  });
  it.each(["https://www.a.example.com/", "a.example.com"])("finds an existing account by website %s and waits", async (Website) => {
    const t = setup(edition), human = t.sim.seed("company", { Account_Name: "Human's name", Website });
    await t.crm.push("r", [lead()]);
    expect(t.sim.count("company")).toBe(1);
    await t.decide("approved");
    expect(human.props.Account_Name).toBe("Human's name");
    expect(t.value("company", "Meridian_Lead_Id")).toBe("a");
  });
  it("a similar domain is not the same company", async () => {
    const t = setup(edition); t.sim.seed("company", { Account_Name: "Other", Website: "data.example.com" });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ created: 1, errors: 0 });
    expect(t.sim.count("company")).toBe(2);
  });
  it("without a domain, the same name waits for a person", async () => {
    const t = setup(edition); t.sim.seed("company", { Account_Name: "O'Brien \\ Sons" });
    await t.crm.push("r", [lead("a", { company: { ...lead().company, name: "O'Brien \\ Sons", domain: null } })]);
    expect(t.sim.count("company")).toBe(1);
    expect(t.crm.status().conflicts).toMatchObject([{ type: "duplicate" }]);
  });
  it("two leads at one company share its account", async () => {
    const t = setup(edition), b = lead("b"); b.company = { ...lead().company };
    expect(await t.crm.push("r", [lead(), b])).toMatchObject({ errors: 0 });
    expect(t.counts()).toEqual([1, 2, 2]);
  });
  it("a new person never inherits the last one's email or title", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]);
    await t.crm.push("r", [lead("a", { contact: { person_id: "p2", name: "New Person", title: "", email: null, email_status: "not_found" } })]);
    expect(t.value("contact", "Last_Name")).toBe("Buyer");
    await t.decide("approved");
    expect(t.value("contact", "Last_Name")).toBe("Person");
    expect(t.value("contact", "Email")).toBeNull();
    expect(t.value("contact", "Title")).toBeNull();
  });
  it("a one-word name still has the mandatory last name", async () => {
    const t = setup(edition), l = lead("a", { contact: { ...lead().contact!, name: "Madonna" } });
    expect(await t.crm.push("r", [l])).toMatchObject({ errors: 0 });
    expect(t.value("contact", "Last_Name")).toBe("Madonna");
    expect(await t.crm.push("r", [l])).toMatchObject({ skipped: 1, errors: 0 });
  });
  it("sends no private data, no delete, no search, and runs no workflow", async () => {
    const t = setup(edition); await t.crm.push("r", [lead()]); await t.crm.push("r", [lead("a", { match: "category_match" })]);
    expect(JSON.stringify(t.sim.requests)).not.toMatch(/SECRET|731431/);
    expect(t.sim.requests.filter(r => r.method === "DELETE" || r.path.endsWith("/search"))).toEqual([]);
    const writes = t.sim.requests.filter(r => ["POST", "PUT"].includes(r.method) && /\/(Accounts|Contacts|Deals)$/.test(r.path));
    expect(writes.length).toBeGreaterThan(2);
    for (const w of writes) { expect(w.body.trigger).toEqual([]); expect(w.body.skip_feature_execution).toEqual([{ name: "cadences" }]); }
    expect(JSON.stringify(t.ledger.db.prepare("SELECT * FROM calls").all())).not.toMatch(/buyer@|access-|refresh|secret/);
  });
  it("50 leads take batches, not 600 calls", async () => {
    const t = setup(edition), many = Array.from({ length: 50 }, (_, i) => lead(`l${i}`));
    expect(await t.crm.push("r", many)).toMatchObject({ created: 50, errors: 0 });
    expect(t.counts()).toEqual([50, 50, 50]);
    expect(t.sim.requests.length).toBeLessThan(80);
    t.sim.requests = [];
    expect(await t.crm.push("r2", many)).toMatchObject({ skipped: 50, errors: 0 });
    expect(t.sim.requests.length).toBeLessThan(15);
  });
  it("one refused row fails that lead alone", async () => {
    const t = setup(edition);
    t.sim.refuse = "Company x";
    expect(await t.crm.push("r", [lead(), lead("x"), lead("y")])).toMatchObject({ created: 2, errors: 1 });
    expect(t.crm.store.outbox().find(l => l.lead_id === "x")!.state).toBe("failed");
    expect(t.counts()).toEqual([2, 2, 2]);
  });
});

describe("Zoho Free: Description belongs to people too", () => {
  it("changes only our lines", () => {
    const before = "Met at the fair.\nMeridian match: product_match\nCall on Monday.";
    expect(writeLines(before, { Meridian_Match: "category_match" })).toBe("Met at the fair.\nMeridian match: category_match\nCall on Monday.");
    expect(writeLines("Notes.", { Meridian_Lead_Id: "a" })).toBe("Meridian ref: a\nNotes.");
  });
  it("keeps what a person wrote", async () => {
    const t = setup("free"); await t.crm.push("r", [lead()]);
    const row = t.sim.rows.deal.get(t.id("deal"))!;
    t.sim.set("deal", row.id, { Description: `${row.props.Description}\nCall on Monday.` });
    await t.crm.push("r", [lead("a", { match: "category_match" })]);
    expect(row.props.Description).toContain("Call on Monday.");
    expect(t.value("deal", "Meridian_Match")).toBe("category_match");
  });
  it("retries instead of overwriting an edit made while it was writing", async () => {
    const t = setup("free"); await t.crm.push("r", [lead()]);
    const row = t.sim.rows.deal.get(t.id("deal"))!;
    t.sim.fail.push({ match: /^PUT \/crm\/v8\/Deals$/, status: 0, run: () => t.sim.set("deal", row.id, { Description: `${row.props.Description}\nTyped just now.` }) });
    expect(await t.crm.push("r", [lead("a", { match: "category_match" })])).toMatchObject({ errors: 1 });
    expect(t.crm.store.outbox()[0].state).toBe("retry");
    t.crm.store.requeueFailed(); await t.crm.drain();
    expect(row.props.Description).toContain("Typed just now.");
    expect(t.value("deal", "Meridian_Match")).toBe("category_match");
  });
  it("finds a record on a later page", async () => {
    const a = setup("free");
    a.sim.pageSize = 2;
    for (let i = 0; i < 7; i++) a.sim.seed("company", { Account_Name: `Other ${i}` });
    await a.crm.push("r", [lead()]);
    const b = setup("free", a.sim); await b.crm.push("r", [lead()]);
    expect(b.sim.count("company")).toBe(8);
  });
  it("an incomplete list creates nothing", async () => {
    const t = setup("free");
    t.sim.fail.push({ match: /^GET \/crm\/v8\/Accounts$/, status: 500 });
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    expect(t.counts()).toEqual([0, 0, 0]);
  });
});

describe("Zoho sign-in, caps and notifications", () => {
  it("refreshes a rejected token once and carries on", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    t.sim.token = "revoked";
    expect(await t.crm.push("r", [lead("b")])).toMatchObject({ created: 1, errors: 0 });
    expect(t.sim.issued).toBe(2);
  });
  it("missing scopes keep the queue and say so", async () => {
    const t = setup(); t.sim.fail.push({ match: /\/org$/, status: 401, code: "OAUTH_SCOPE_MISMATCH" });
    expect((await t.crm.push("r", [lead()])).details[0].message).toMatch(/SCOPE_MISMATCH/);
    expect(t.crm.store.outbox()[0].state).toBe("pending");
  });
  it("counts credits against a rolling cap and keeps the queue", async () => {
    vi.stubEnv("CRM_ZOHO_DAILY_CREDIT_LIMIT", "12");
    const t = setup();
    expect(await t.crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    expect(t.crm.status().calls_today.used).toBeLessThanOrEqual(12);
    expect(t.crm.store.outbox()[0].state).toBe("pending");
  });
  it("throttling never uses up the attempts", async () => {
    const t = setup();
    for (let i = 0; i < 8; i++) {
      t.sim.fail.push({ match: /^POST \/crm\/v8\/Deals$/, status: 429 });
      if (i === 0) await t.crm.push("r", [lead()]);
      else { t.ledger.db.prepare("UPDATE crm_outbox SET next_at=0").run(); await t.crm.drain(); }
    }
    expect(t.crm.store.outbox()[0].state).toBe("retry");
  });
  it("many records missing at once is a fault, not deletes", async () => {
    const t = setup(); await t.crm.push("r", Array.from({ length: 6 }, (_, i) => lead(`m${i}`)));
    t.sim.rows.company.clear();
    const r = await t.crm.pull();
    expect(r.error).toMatch(/fault/); expect(r.conflicts).toBe(0);
  });
  it("registers notifications for under a week, once", async () => {
    const t = setup("enterprise", undefined, undefined, undefined, "https://hook.example/api/crm/webhook/zoho");
    await t.crm.push("r", [lead()]); await t.crm.pull(); await t.crm.pull();
    expect(t.sim.watches).toHaveLength(3);
    for (const w of t.sim.watches) {
      expect(w.token).toBe("hook"); expect(w.token.length).toBeLessThanOrEqual(50);
      expect(Date.parse(w.channel_expiry) - Date.now()).toBeLessThan(7 * 86_400_000);
    }
  });
  it("asks for no delete permission", () => {
    expect(ZOHO_SCOPES.filter(s => /DELETE|\.ALL/.test(s))).toEqual([]);
  });
});

describe("connections and clients", () => {
  it("each client's leads go only to that client's CRM", async () => {
    clearEnv();
    const c = new Connections(file(), BOTH), hub = new Map<string, HubSpotSimulator>([["token-a", new HubSpotSimulator()], ["token-b", new HubSpotSimulator()]]);
    hub.get("token-b")!.portal = 2;
    for (const k of ["a", "b"]) c.save(`hubspot@${k}`, { provider: "hubspot", client: k, token: `token-${k}` });
    const http: typeof fetch = (url, init) => hub.get((init!.headers as any).authorization.slice(7))!.fetch(url, init);
    const crm = new CrmHub(new Ledger(":memory:"), c, http);
    const r = await crm.push("r", [lead("one", { client_id: "a" }), lead("two", { client_id: "b" }), lead("three", { client_id: "nobody" })]);
    expect(r).toMatchObject({ created: 2, errors: 1 });
    expect(JSON.stringify(hub.get("token-a")!.requests)).not.toContain("Company two");
    expect(JSON.stringify(hub.get("token-b")!.requests)).not.toContain("Company one");
  });
  it("two clients cannot share one CRM account", async () => {
    clearEnv();
    const c = new Connections(file(), BOTH), sim = new HubSpotSimulator();
    for (const k of ["a", "b"]) c.save(`hubspot@${k}`, { provider: "hubspot", client: k, token: k });
    const crm = new CrmHub(new Ledger(":memory:"), c, sim.fetch);
    await crm.push("r", [lead("one", { client_id: "a" })]);
    expect((await crm.push("r", [lead("two", { client_id: "b" })])).details[0].message).toMatch(/cannot share/);
  });
  it("leads queued before a sign-in follow the CRM that gets connected", async () => {
    clearEnv();
    const c = new Connections(file(), BOTH), sim = new ZohoSimulator(), crm = new CrmHub(new Ledger(":memory:"), c, sim.fetch);
    expect(await crm.push("r", [lead()])).toMatchObject({ errors: 1 });
    c.save("zoho", { provider: "zoho", client: "*", app_id: "i", app_secret: "s", refresh_token: "r" });
    await crm.poll(new Map(), 0);
    expect(sim.count("deal")).toBe(1);
  });
  it("an approved draft reaches the CRM on the next poll", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    const run = t.ledger.createRun({ product: "sample", target_country: "DEU", min_headcount: 20, max_headcount: 2000 });
    const a = t.ledger.proposeAction(run, "email_draft", "draft-a", { lead_id: "a" });
    t.ledger.decideAction(a.id, "approved");
    expect(t.crm.refreshStatuses()).toBe(1); await t.crm.drain();
    expect(t.value("deal", "Meridian_Status")).toBe("draft approved");
  });
  it("keeps secrets in a private file and out of every answer", async () => {
    const t = setup(); await t.crm.push("r", [lead()]);
    expect(statSync(t.path).mode & 0o777).toBe(0o600);
    const hub = new CrmHub(t.ledger, t.connections, t.sim.fetch);
    expect(JSON.stringify([hub.describe(), t.crm.status()])).not.toMatch(/secret|refresh|access-|hook/i);
  });
  it("HubSpot also writes 50 leads in batches", async () => {
    const sim = new HubSpotSimulator(), crm = new CrmSync(new Ledger(":memory:"), m => new HubSpot(m, { token: "t", fetch: sim.fetch, gapMs: 0 }));
    const many = Array.from({ length: 50 }, (_, i) => lead(`l${i}`));
    expect(await crm.push("r", many)).toMatchObject({ created: 50, errors: 0 });
    expect(sim.count("deal")).toBe(50); expect(sim.requests.length).toBeLessThan(80);
  });
});

describe("what is on offer", () => {
  it("HubSpot only: Zoho cannot be connected, picked or signed in to", async () => {
    clearEnv();
    vi.stubEnv("ZOHO_CLIENT_ID", "i"); vi.stubEnv("ZOHO_CLIENT_SECRET", "s"); vi.stubEnv("ZOHO_REFRESH_TOKEN", "r");
    const c = new Connections(file()), hub = new CrmHub(new Ledger(":memory:"), c, vi.fn() as any);
    c.save("zoho", { provider: "zoho", client: "*", app_id: "i", app_secret: "s", refresh_token: "r" });
    expect(hub.describe()).toEqual([]); expect(hub.configured()).toBe(false);
    expect(hub.pick()!.adapter.name).toBe("hubspot");
    expect(connectionView(hub.pick()!, { hub }).providers).toEqual({ hubspot: "available", zoho: "coming_soon", salesforce: "coming_soon", pipedrive: "coming_soon" });
    const route = createCrmRouter(hub), server = createServer(async (q, r) => { await route(q, r); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/crm/oauth/start?provider=zoho`, { redirect: "manual" });
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: "zoho is coming soon" });
    } finally { startPolling(hub)(); server.close(); }
  });
});

describe("browser sign-in and notification routes", () => {
  it("signs in once per state, refuses a foreign sign-in server, and wakes on a true token only", async () => {
    clearEnv();
    const sim = new ZohoSimulator(), c = new Connections(file(), BOTH), hub = new CrmHub(new Ledger(":memory:"), c, sim.fetch);
    c.save("zoho", { provider: "zoho", client: "*", app_id: "app", app_secret: "app-secret" });
    const route = createCrmRouter(hub), server = createServer(async (q, r) => { await route(q, r); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/crm`, get = (p: string) => fetch(base + p, { redirect: "manual" });
    try {
      const state = async () => new URL((await get("/oauth/start?provider=zoho")).headers.get("location")!).searchParams.get("state");
      expect((await get("/oauth/callback?code=x&state=forged")).status).toBe(400);
      expect((await get(`/oauth/callback?code=x&state=${await state()}&accounts-server=${encodeURIComponent("https://evil.example")}`)).status).toBe(400);
      expect(sim.issued).toBe(0);
      const s = await state();
      expect((await get(`/oauth/callback?code=x&state=${s}&accounts-server=${encodeURIComponent("https://accounts.zoho.eu")}`)).status).toBe(302);
      expect((await get(`/oauth/callback?code=x&state=${s}`)).status).toBe(400);
      expect(c.get("zoho")).toMatchObject({ accounts_url: "https://accounts.zoho.eu", refresh_token: "refresh-1" });
      const hook = (token: string) => fetch(`${base}/webhook/zoho`, { method: "POST", body: JSON.stringify({ token }) });
      expect((await hook("wrong")).status).toBe(401);
      expect((await hook(c.get("zoho")!.hook_secret!)).status).toBe(200);
      expect(await (await fetch(`${base}/connection?connection=nope`)).status).toBe(404);
    } finally { startPolling(hub)(); server.close(); }
  });
});
