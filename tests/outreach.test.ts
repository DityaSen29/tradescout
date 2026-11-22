import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { classifyReply, newText, redact } from "../src/outreach/classify.js";
import { compose, delayFrom, nextAction, type PlanModel } from "../src/outreach/brain.js";
import { checkDomain, dailyCap, dayStart } from "../src/outreach/deliverability.js";
import { draftHash, Outreach, outgoingBody, type OutreachOptions } from "../src/outreach/engine.js";
import { buildMime, type Mailbox } from "../src/outreach/mail.js";
import { makeCall } from "../src/outreach/io.js";
import { open, seal } from "../src/outreach/secrets.js";
import { SimMailbox } from "../src/outreach/simulate.js";
import type { MailboxRow } from "../src/outreach/store.js";

const FROM = "sales@seller.example", TO = "anna@buyer.example";
const DAY = 86_400_000;
const RECORDS: Record<string, string[]> = {
  "seller.example": ["v=spf1 include:_spf.google.com ~all"], "_spf.google.com": ["v=spf1 ip4:192.0.2.0/24 ~all"],
  "google._domainkey.seller.example": ["v=DKIM1; p=ABCDEF"], "_dmarc.seller.example": ["v=DMARC1; p=reject"],
};
const txt = async (name: string) => RECORDS[name] ?? [];
// the model is always stubbed: no test reaches a provider
const classify = (label: string, confidence = 0.95) => async () => ({ label, confidence, usd: 0.0001 });
const plan = (value: object): PlanModel => async () => ({ usd: 0.0001, value: { angle: "offer_call", fact_ids: [], confidence: 0.9, reason: "test", ...value } });
const failing: PlanModel = async () => { throw new Error("model down"); };

function setup(opts: Partial<OutreachOptions> = {}, live = false) {
  const ledger = new Ledger(":memory:");
  const clock = { at: Date.now() + 1000 };
  const now = () => clock.at;
  const sim = new SimMailbox(FROM, ledger, now);
  const engine = new Outreach(ledger, {
    simulate: !live, now, txt, model: classify("not_interested"), planner: failing,
    mailbox: () => sim, ...opts,
  });
  engine.s.saveMailbox(FROM, live ? "gmail" : "simulated", null);
  engine.s.campaign("client");
  engine.s.run("UPDATE outreach_campaigns SET mailbox=? WHERE client_id='client'", FROM);
  const run = ledger.createRun({ product: "filter fabric", target_country: "DEU", min_headcount: 20, max_headcount: 2000 });
  const draft = (extra: Record<string, unknown> = {}, key = String(Math.random())) => {
    const subject = "Filter fabric", body = "Hi Anna,\n\nWould a sample be useful?";
    return ledger.proposeAction(run, "email_draft", key, {
      lead_id: "lead", client_id: "client", run_id: run, step: 1, to_name: "Anna", to_title: "Buyer", to_email: TO, to_email_status: "deliverable",
      company: "Buyer Example", subject, body, sentences: [], draft_hash: draftHash(subject, body), dedupe_key: `d:${key}`, based_on: [], ...extra,
    });
  };
  const first = async () => {
    const a = draft();
    ledger.decideAction(a.id, "approved");
    expect(await engine.execute(a.id)).toMatchObject({ sent: true });
    return a;
  };
  const sentMail = () => sim.search("in:sent");
  const proposed = () => engine.drafts("proposed");
  const approveNext = () => { const a = proposed()[0]; ledger.decideAction(a.id, "approved"); return a; };
  const auto = () => engine.s.run("UPDATE outreach_campaigns SET mode='auto' WHERE client_id='client'");
  const enrollment = () => engine.s.enrollment("client", TO)!;
  return { ledger, engine, sim, clock, now, run, draft, first, sentMail, proposed, approveNext, auto, enrollment };
}
afterEach(() => { delete process.env.OUTREACH_TEST_RECIPIENTS; });

describe("sending", () => {
  it("needs approval, then sends exactly once", async () => {
    const t = setup(), a = t.draft();
    expect(await t.engine.execute(a.id)).toMatchObject({ sent: false, reason: "It needs approval first." });
    t.ledger.decideAction(a.id, "approved");
    const [x, y] = await Promise.all([t.engine.execute(a.id), t.engine.execute(a.id)]);
    expect([x.sent, y.sent].filter(Boolean)).toHaveLength(1);
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("two processes on one ledger still send once", async () => {
    const t = setup(), a = t.draft();
    t.ledger.decideAction(a.id, "approved");
    const other = new Outreach(t.ledger, { simulate: true, now: t.now, txt, planner: failing, mailbox: () => t.sim });
    await Promise.all([t.engine.execute(a.id), other.execute(a.id)]);
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("won't email the same person twice for one client from another run", async () => {
    const t = setup();
    await t.first();
    const b = t.draft();
    t.ledger.decideAction(b.id, "approved");
    expect((await t.engine.execute(b.id)).reason).toContain("already in this client's campaign");
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("refuses edited text, unverified addresses and header injection", async () => {
    for (const extra of [{ body: "changed" }, { to_email_status: "catch_all" }, { to_email: "a@buyer.example\r\nBcc: x@y.example" }]) {
      const t = setup(), a = t.draft(extra);
      t.ledger.decideAction(a.id, "approved");
      expect((await t.engine.execute(a.id)).sent).toBe(false);
      expect(await t.sentMail()).toHaveLength(0);
    }
  });
  it("live mode emails nobody outside the team test inboxes, and nobody when the list is empty", async () => {
    for (const list of [undefined, "*", "other@team.example", "buyer.example"]) {
      if (list) process.env.OUTREACH_TEST_RECIPIENTS = list;
      const t = setup({}, true), a = t.draft();
      t.ledger.decideAction(a.id, "approved");
      expect((await t.engine.execute(a.id)).reason).toContain("Test mode");
      expect(await t.sentMail()).toHaveLength(0);
    }
    process.env.OUTREACH_TEST_RECIPIENTS = TO;
    const t = setup({}, true);
    await t.first();
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("an accepted send with a lost response is found in Sent, never resent", async () => {
    const t = setup();
    let lose = true;
    const box: Mailbox = {
      email: FROM, get: id => t.sim.get(id), thread: id => t.sim.thread(id), search: q => t.sim.search(q),
      send: async m => { const r = await t.sim.send(m); if (lose) { lose = false; throw new Error("timeout"); } return r; },
    };
    const engine = new Outreach(t.ledger, { simulate: true, now: t.now, txt, planner: failing, mailbox: () => box });
    const a = t.draft();
    t.ledger.decideAction(a.id, "approved");
    expect(await engine.execute(a.id)).toMatchObject({ sent: false, status: "unknown" });
    expect((await engine.execute(a.id)).reason).toContain("Check and retry");
    expect(await engine.reconcile(a.id)).toMatchObject({ status: "executed" });
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("a failed send waits two minutes and a person before one retry", async () => {
    const t = setup();
    let fail = true;
    const box: Mailbox = {
      email: FROM, get: id => t.sim.get(id), thread: id => t.sim.thread(id), search: q => t.sim.search(q),
      send: async m => { if (fail) { fail = false; throw new Error("503"); } return t.sim.send(m); },
    };
    const engine = new Outreach(t.ledger, { simulate: true, now: t.now, txt, planner: failing, mailbox: () => box });
    const a = t.draft();
    t.ledger.decideAction(a.id, "approved");
    await engine.execute(a.id);
    await engine.tick();
    expect((await engine.reconcile(a.id)).reason).toContain("two minutes");
    t.clock.at += 121_000;
    expect(await engine.reconcile(a.id)).toMatchObject({ sent: true });
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("a sender killed mid-send becomes unknown, then is recovered from Sent", async () => {
    const t = setup(), a = await t.first();
    t.ledger.db.prepare("UPDATE actions SET status='executing', executor='999999:gone' WHERE id=?").run(a.id);
    await t.engine.tick();
    expect(t.ledger.getAction(a.id)!.status).toBe("executed");
    expect(await t.sentMail()).toHaveLength(1);
  });
});

describe("sequence", () => {
  it("follows up on days 3, 7 and 14 in one thread, then ends", async () => {
    const t = setup();
    t.auto();
    const start = t.clock.at;
    await t.first();
    for (const [day, count] of [[2.9, 1], [3, 2], [6.9, 2], [7, 3], [13.9, 3], [14, 4], [40, 4]]) {
      t.clock.at = start + day * DAY;
      await t.engine.tick();
      expect(await t.sentMail(), `day ${day}`).toHaveLength(count);
    }
    const mail = await t.sim.thread(t.enrollment().thread_id!);
    expect(mail).toHaveLength(4);
    expect(mail[3].headers["in-reply-to"]).toBe(mail[2].headers["message-id"]);
    expect(mail[3].headers.subject).toBe("Re: Filter fabric");
    expect(t.enrollment().state).toBe("finished");
  });
  it("approval mode waits for a person, even when due", async () => {
    const t = setup();
    await t.first();
    t.clock.at += 3 * DAY;
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(1);
    t.approveNext();
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(2);
  });
  it("an approval given early still waits for day 3", async () => {
    const t = setup();
    await t.first();
    t.approveNext();
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("a paused campaign sends nothing", async () => {
    const t = setup();
    await t.first();
    t.auto();
    t.engine.s.run("UPDATE outreach_campaigns SET paused=1");
    t.clock.at += 4 * DAY;
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(1);
  });
});

describe("the follow-up bug: reply first, then send", () => {
  const cases: [string, string, string, Record<string, string>, boolean][] = [
    ["a reply in the thread", TO, "Thanks, not for us", {}, true],
    ["a reply in a new thread", TO, "Thanks, not for us", {}, false],
    ["a colleague in a new thread", "boss@buyer.example", "Please talk to me", {}, false],
    ["a bounce", "mailer-daemon@mail.example", `550 5.1.1 address not found: ${TO}`, {}, false],
    ["an out-of-office", TO, "I am away", { "auto-submitted": "auto-replied" }, true],
    ["an opt-out", TO, "STOP", {}, false],
  ];
  for (const [name, from, text, headers, inThread] of cases) it(`${name} that lands after approval stops the send`, async () => {
    const t = setup();
    await t.first();
    t.clock.at += 3 * DAY;
    const next = t.approveNext();
    t.sim.receive(inThread ? t.enrollment().thread_id : null, from, text, "Re: Filter fabric", headers);
    expect((await t.engine.execute(next.id)).sent).toBe(false);
    expect(t.enrollment().state).toBe("stopped");
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("a person answering in the thread stops it", async () => {
    const t = setup();
    await t.first();
    await t.sim.send({ to: TO, subject: "Re: Filter fabric", body: "Me again", key: "", threadId: t.enrollment().thread_id });
    await t.engine.tick();
    expect(t.enrollment().reason).toBe("a person took over");
  });
  it("sends nothing when replies can't be read", async () => {
    const t = setup();
    await t.first();
    t.clock.at += 3 * DAY;
    const next = t.approveNext();
    t.sim.search = async () => { throw new Error("Gmail down"); };
    expect((await t.engine.execute(next.id)).reason).toContain("Not sent");
    expect(t.ledger.getAction(next.id)!.status).toBe("approved");
  });
  it("an opt-out suppresses the address for every client and survives a model outage", async () => {
    const t = setup({ model: async () => { throw new Error("down"); } });
    await t.first();
    t.sim.receive(null, TO, "", "unsubscribe");
    await t.engine.tick();
    expect(t.engine.s.suppressed(TO)?.reason).toBe("unsubscribed");
    t.engine.s.run("INSERT INTO outreach_campaigns (client_id,mailbox) VALUES ('second',?)", FROM);
    const b = t.draft({ client_id: "second" });
    t.ledger.decideAction(b.id, "approved");
    expect((await t.engine.execute(b.id)).reason).toContain("suppressed");
  });
  it("a temporary bounce stops without suppressing", async () => {
    const t = setup();
    await t.first();
    t.sim.receive(null, "mailer-daemon@mail.example", `Delivery has been delayed to ${TO}, will retry`);
    await t.engine.tick();
    expect(t.enrollment().reason).toBe("bounced");
    expect(t.engine.s.suppressed(TO)).toBeNull();
  });
});

describe("next best action", () => {
  it("a hot lead gets an alert and a booking draft that full auto never sends", async () => {
    const t = setup({ model: classify("interested"), planner: plan({ action: "book" }) });
    t.auto();
    await t.first();
    t.clock.at += 60_000;
    t.sim.receive(t.enrollment().thread_id, TO, "Yes, send a sample and let's talk");
    await t.engine.tick();
    await t.engine.tick();
    const answer = t.proposed().find(a => (a.payload as any).outreach.kind === "reply")!;
    expect(String(answer.payload.body)).toContain("15-minute call");
    expect(await t.sentMail()).toHaveLength(1);
    const alerts = t.engine.s.all<any>("SELECT * FROM outreach_alerts WHERE text LIKE 'Hot lead%' AND channel='desk'");
    expect(alerts).toHaveLength(1);
    expect(t.engine.score(t.enrollment()).score).toBe(90);
    t.ledger.decideAction(answer.id, "approved");
    expect(await t.engine.execute(answer.id)).toMatchObject({ sent: true });
  });
  it("answers only in the product file's words", async () => {
    let id = "";
    const t = setup({ model: classify("question"), planner: async (s, i) => plan({ action: "answer", fact_ids: [id, "made-up"], body: "We are ISO certified" })(s, i) });
    t.engine.setFacts("client", ["Minimum order is 500 metres."]);
    id = t.engine.facts("client")[0].id;
    await t.first();
    t.clock.at += 60_000;
    t.sim.receive(null, TO, "What is your minimum?");
    await t.engine.tick();
    const body = String(t.proposed().find(a => (a.payload as any).outreach.kind === "reply")!.payload.body);
    expect(body).toContain("Minimum order is 500 metres.");
    expect(body).not.toMatch(/ISO/);
  });
  it("a question the file can't answer goes to a person", async () => {
    const t = setup({ model: classify("question"), planner: plan({ action: "answer", fact_ids: ["none"] }) });
    await t.first();
    t.clock.at += 60_000;
    t.sim.receive(null, TO, "Are you certified?");
    await t.engine.tick();
    expect(t.proposed().filter(a => (a.payload as any).outreach.kind === "reply")).toHaveLength(0);
  });
  it("waits as long as they asked, and still needs approval", async () => {
    const t = setup({ model: classify("not_now"), planner: plan({ action: "wait", delay_days: 5 }) });
    await t.first();
    t.clock.at += 60_000;
    t.sim.receive(null, TO, "Try me again in two months");
    await t.engine.tick();
    const later = t.proposed().find(a => (a.payload as any).outreach.kind === "reply")!;
    t.ledger.decideAction(later.id, "approved");
    t.clock.at += 59 * DAY;
    expect((await t.engine.execute(later.id)).reason).toContain("later");
    t.clock.at += 1.1 * DAY;
    expect(await t.engine.execute(later.id)).toMatchObject({ sent: true });
  });
  it("a follow-up the runner is unsure of is held from full auto", async () => {
    const t = setup({ planner: plan({ action: "escalate" }) });
    t.auto();
    await t.first();
    t.clock.at += 3 * DAY;
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(1);
  });
  it("memory stops a fact being repeated, and the model can't invent an action", async () => {
    const ledger = new Ledger(":memory:");
    const run = ledger.createRun({ product: "x", target_country: "DEU", min_headcount: 1, max_headcount: 2 });
    const memory = { product: "fabric", facts: [{ id: "a", text: "Fact" }], turns: [], used: { angles: ["product_fit" as const], fact_ids: ["a"] }, reply: null, step: 3, score: 50 };
    const call = makeCall(ledger, run);
    expect((await nextAction(memory, { call, now: 0, model: plan({ action: "follow_up", angle: "product_fit", fact_ids: ["a"] }) })).fact_ids).toEqual([]);
    expect((await nextAction(memory, { call, now: 0, model: plan({ action: "book" }) })).by).toBe("rule");
  });
  it("reads dates from the person's words", () => {
    const now = Date.parse("2026-11-22T11:00:00Z");
    expect(delayFrom("back in two weeks", now)).toBe(14);
    expect(delayFrom("next quarter please", now)).toBe(91);
    expect(delayFrom("we may reconsider", now)).toBeNull();
    expect(delayFrom("write in January", now)).toBeGreaterThan(40);
  });
});

describe("classifier", () => {
  it("doesn't read our quoted STOP line as an opt-out", async () => {
    const quoted = `Sounds good\n\nOn Sun, 22 Nov 2026 at 10:00, Sales <${FROM}> wrote:\n> ${outgoingBody("Hello")}`;
    expect(newText(quoted)).toBe("Sounds good");
    expect((await classifyReply(quoted)).label).not.toBe("unsubscribe");
    expect((await classifyReply(quoted.replace("Sounds good", "Stop"))).label).toBe("unsubscribe");
  });
  for (const text of ["STOP", "Please remove me from your list", "don't email me again", "Not for us.\nStop"]) it(`opt-out: ${JSON.stringify(text)}`, async () => {
    expect((await classifyReply(text)).label).toBe("unsubscribe");
  });
  it("hides contact details, names and figures from the model", () => {
    const out = redact("Hi Ravi,\nI'm Anna Schmidt. Email anna@buyer.example or +49 170 1234567, budget EUR 20,000.\nBest,\nAnna", ["Anna"]);
    expect(out).not.toMatch(/Ravi|Anna|Schmidt|buyer\.example|1234567|20,000/);
  });
  it("anything it can't classify goes to a person", async () => {
    expect(await classifyReply("Hmm")).toMatchObject({ by: "fallback", escalate: true });
  });
});

describe("deliverability and caps", () => {
  it("passes a healthy domain", async () => {
    const h = await checkDomain("seller.example", { txt });
    expect([h.spf.level, h.dkim.level, h.dmarc.level]).toEqual(["ok", "ok", "ok"]);
  });
  it("flags missing, doubled and open SPF, and never calls a DNS failure healthy", async () => {
    const check = async (rows: string[]) => (await checkDomain("x.example", { txt: async n => (n === "x.example" ? rows : []) })).spf.level;
    expect(await check([])).toBe("fail");
    expect(await check(["v=spf1 ~all", "v=spf1 -all"])).toBe("fail");
    expect(await check(["v=spf1 +all"])).toBe("fail");
    const down = await checkDomain("x.example", { txt: async () => { throw new Error("SERVFAIL"); } });
    expect([down.spf.level, down.dkim.level, down.dmarc.level]).toEqual(["unknown", "unknown", "unknown"]);
  });
  it("inherits the parent's subdomain DMARC policy", async () => {
    const h = await checkDomain("mail.seller.example", { txt: async n => (n === "_dmarc.seller.example" ? ["v=DMARC1; p=reject; sp=none"] : []) });
    expect(h.dmarc.level).toBe("warn");
  });
  it("ramps, and the operator can only lower it", async () => {
    const health = await checkDomain("seller.example", { txt }), now = Date.now();
    const base = { health, now, sentToday: 0, manual: null, ceiling: 40, bounces: 0, recentSends: 0 };
    expect([0, 7, 14, 21].map(d => dailyCap({ ...base, firstSend: now - d * DAY }).limit)).toEqual([10, 20, 30, 40]);
    expect(dailyCap({ ...base, firstSend: null, manual: 100 }).limit).toBe(10);
    expect(dailyCap({ ...base, firstSend: null, bounces: 3, recentSends: 20 }).limit).toBe(0);
    expect(dayStart(Date.parse("2026-11-22T11:00:00Z"))).toBe(Date.parse("2026-11-21T18:30:00Z"));
  });
  it("holds the queue at the day's cap", async () => {
    const t = setup();
    for (let i = 0; i < 12; i++) t.ledger.decideAction(t.draft({ to_email: `p${i}@buyer${i}.example`, lead_id: `l${i}` }).id, "approved");
    await t.engine.tick();
    expect(await t.sentMail()).toHaveLength(10);
  });
});

describe("secrets and headers", () => {
  it("binds an encrypted token to its mailbox", () => {
    const key = randomBytes(32), sealed = seal("refresh-token", FROM, key);
    expect(sealed).not.toContain("refresh-token");
    expect(open(sealed, FROM, key)).toBe("refresh-token");
    expect(() => open(sealed, TO, key)).toThrow();
  });
  it("can't be made to add a header", () => {
    const mime = buildMime(FROM, { to: TO, toName: "A\r\nBcc: x@y.example", subject: "Hi\r\nBcc: z@y.example", body: "hello", key: "k" });
    expect(mime).not.toMatch(/^Bcc:/m);
  });
  it("compose only uses facts by id", () => {
    expect(compose({ action: "answer", angle: "resurface", fact_ids: ["x"], delay_days: null, confidence: 1, reason: "", by: "llm" }, { first: "A", company: "C", product: "P", facts: [], link: null })).not.toContain("x ");
  });
});
