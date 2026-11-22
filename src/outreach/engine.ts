import { createHash, randomUUID } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import { budgetDay } from "../core/limits.js";
import type { ProposedAction } from "../core/types.js";
import type { OutreachDraft } from "../buyer/contract.js";
import { Alerts } from "./alerts.js";
import { compose, leadScore, nextAction, type Angle, type Fact, type Plan, type PlanModel } from "./brain.js";
import { classifyReply, newText, type ClassifyOptions, type ReplyLabel } from "./classify.js";
import { address, DAY_MS, domainOf, FOLLOW_UP_DAYS, operatorCap, OPT_OUT, testRecipients } from "./config.js";
import { checkDomain, dailyCap, dayStart, type Cap, type DomainHealth, type TxtLookup } from "./deliverability.js";
import { GmailMailbox } from "./google.js";
import { makeCall } from "./io.js";
import { ALERT_HEADER, fromAddress, KEY_HEADER, type Mailbox } from "./mail.js";
import { SimMailbox } from "./simulate.js";
import { store, type Enrollment, type Inbound, type MailboxRow, type SendRow, type Store } from "./store.js";

export interface OutreachOptions {
  /** Uses only the simulated mailbox. The server gives it a database of its own. */
  simulate?: boolean;
  now?: () => number;
  txt?: TxtLookup;
  model?: ClassifyOptions["model"];
  planner?: PlanModel;
  mailbox?: (row: MailboxRow) => Mailbox;
}
export interface SendResult { sent: boolean; status: string; reason: string | null }

interface Meta {
  kind: "follow_up" | "reply"; enrollment_id: string; reply_to?: string;
  plan?: Plan;
  /** Earliest send, when the person said "later". */
  not_before?: number;
  /** The runner wants a person on this one, so full auto won't approve it. */
  needs_person?: boolean;
}
type Draft = OutreachDraft & { outreach?: Meta };
interface Ready { draft: Draft; to: string; mailbox: string; enrollment: Enrollment | null; key: string; reply: Inbound | null; previous: SendRow | null }
type Guard = { ok: true; value: Ready } | { ok: false; reason: string };
const no = (reason: string): Guard => ({ ok: false, reason });

export const draftHash = (subject: string, body: string) => createHash("sha256").update(`${subject}\n${body}`).digest("hex");
/** What actually goes out: the approved words, then the fixed opt-out line. The desk previews exactly this. */
export const outgoingBody = (body: string) => (body.includes(OPT_OUT) ? body : `${body.trimEnd()}\n\n${OPT_OUT}`);
const sendKey = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
const why = (err: unknown) => String((err as any)?.message ?? err).slice(0, 220);
const FREEMAIL = /^(gmail\.com|googlemail\.com|(outlook|hotmail|live|yahoo|icloud|proton|protonmail|rediffmail|zoho|gmx|web|aol|msn|qq|163|126|mail|yandex)\.(com|de|net|ru|me|co\.uk|co\.in|fr|in)|me\.com)$/;
const LEASE_MS = 120_000;

function isBounce(from: string, headers: Record<string, string>) {
  return /^(mailer-daemon|postmaster)@/.test(from) || /^(mailer-daemon|postmaster)$/.test(from) || !!headers["x-failed-recipients"] || /report-type="?delivery-status/i.test(headers["content-type"] ?? "");
}
function isHardBounce(text: string) {
  if (/\b(delivery (has been )?delayed|delivery incomplete|will (keep trying|retry)|temporary (failure|problem|error))\b/i.test(text)) return false;
  return /\b5\.\d{1,3}\.\d{1,3}\b|address not found|does(n't| not) exist|couldn't be found|user unknown|no such user|unknown recipient|550\b/i.test(text);
}
function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err.code === "EPERM"; }
}

export class Outreach {
  readonly s: Store;
  readonly alerts: Alerts;
  readonly simulated: boolean;
  private readonly owner = randomUUID();

  constructor(readonly ledger: Ledger, private opts: OutreachOptions = {}) {
    this.s = store(ledger);
    this.simulated = !!opts.simulate;
    this.alerts = new Alerts(ledger, {
      now: () => this.now(), live: !this.simulated,
      sender: () => { const m = this.usableMailboxes()[0]; return m ? this.box(m.email) : null; },
    });
  }

  now(): number {
    if (this.opts.now) return this.opts.now();
    return Date.now() + (this.simulated ? Number(this.s.get("sim_offset") ?? 0) : 0);
  }
  usableMailboxes() { return this.s.mailboxes().filter(m => m.transport === (this.simulated ? "simulated" : "gmail")); }
  box(email: string, runId = "outreach"): Mailbox {
    const row = this.s.mailbox(email);
    if (!row || row.transport !== (this.simulated ? "simulated" : "gmail")) throw new Error(`${email} is not connected`);
    if (this.opts.mailbox) return this.opts.mailbox(row);
    if (this.simulated) return new SimMailbox(email, this.ledger, () => this.now());
    if (!row.token) throw new Error(`${email} needs connecting again`);
    return new GmailMailbox(email, row.token, makeCall(this.ledger, runId));
  }

  // ---- mailbox health and caps -------------------------------------------
  async checkMailbox(email: string): Promise<DomainHealth> {
    const row = this.s.mailbox(email);
    if (!row) throw new Error("No such mailbox.");
    const health = await checkDomain(domainOf(email), { txt: this.opts.txt, selector: row.dkim_selector, call: makeCall(this.ledger, "outreach") });
    health.checked_at = new Date(this.now()).toISOString();
    this.s.run("UPDATE outreach_mailboxes SET health=? WHERE email=?", JSON.stringify(health), email);
    return health;
  }
  private async freshHealth(email: string) {
    const raw = this.s.mailbox(email)?.health;
    const h: DomainHealth | null = raw ? JSON.parse(raw) : null;
    const age = h ? this.now() - Date.parse(h.checked_at) : Infinity;
    const unknown = !!h && [h.spf, h.dkim, h.dmarc].some(c => c.level === "unknown");
    if (age > DAY_MS || (unknown && age > 300_000)) await this.checkMailbox(email);
  }
  cap(email: string): Cap {
    const row = this.s.mailbox(email)!;
    const now = this.now(), week = now - 7 * DAY_MS;
    const n = (sql: string, ...a: any[]) => Number(this.s.one<{ n: number }>(sql, ...a)?.n ?? 0);
    return dailyCap({
      health: row.health ? JSON.parse(row.health) : null, now, manual: row.cap, ceiling: operatorCap(),
      firstSend: this.s.one<{ n: number | null }>("SELECT MIN(at) n FROM outreach_sends WHERE mailbox=? AND state='sent'", email)?.n ?? null,
      sentToday: n("SELECT COUNT(*) n FROM outreach_sends WHERE mailbox=? AND state<>'not_sent' AND at>=?", email, dayStart(now)),
      recentSends: n("SELECT COUNT(*) n FROM outreach_sends WHERE mailbox=? AND state<>'not_sent' AND at>=?", email, week),
      bounces: n("SELECT COUNT(DISTINCT id) n FROM outreach_inbound WHERE mailbox=? AND kind='bounce' AND at>=?", email, week),
    });
  }

  // ---- the gate in front of every send -----------------------------------
  /** No network and no await, so it can run again in the same instant the ledger claim is made. */
  guard(a: ProposedAction): Guard {
    if (a.kind !== "email_draft") return no("This isn't an email draft.");
    const d = a.payload as unknown as Draft;
    if (![d.client_id, d.lead_id, d.subject, d.body, d.draft_hash, d.dedupe_key].every(v => typeof v === "string" && v.trim())) return no("The draft is missing required fields.");
    if (draftHash(d.subject, d.body) !== d.draft_hash) return no("The text changed after it was written. It needs a new draft and a new approval.");
    if (/[\r\n]/.test(d.subject) || d.subject.length > 250 || d.body.length > 10_000) return no("The subject or body isn't a valid email.");
    const to = address(d.to_email);
    if (!to) return no("There is no valid email address.");
    if (d.to_email_status !== "deliverable") return no("The address isn't verified as deliverable.");
    if (!this.simulated && !testRecipients().has(to)) return no("Test mode: this isn't a team test inbox, so it will not be emailed.");
    const blocked = this.s.suppressed(to);
    if (blocked) return no(`This address is suppressed (${blocked.reason}).`);

    const campaign = this.s.campaign(d.client_id);
    if (campaign.paused) return no("The campaign is paused.");
    const e = this.s.enrollment(d.client_id, to);
    const mailbox = e?.mailbox ?? campaign.mailbox;
    if (!mailbox || !this.usableMailboxes().some(m => m.email === mailbox)) return no("Choose a connected mailbox for this client.");
    if (mailbox === to) return no("A mailbox can't run a campaign to itself.");

    let reply: Inbound | null = null, previous: SendRow | null = null;
    const meta = d.outreach;
    if (meta?.kind === "reply") {
      if (!e || e.id !== meta.enrollment_id || e.state === "booked" || e.reason !== "replied") return no("This conversation is closed.");
      reply = this.s.inbound(e.id).find(m => m.id === meta.reply_to && m.kind === "reply") ?? null;
      if (!reply) return no("The reply this answers wasn't found.");
      if (meta.not_before && this.now() < meta.not_before) return no(`They asked for later. Due ${new Date(meta.not_before).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}.`);
      if (this.s.inbound(e.id).some(m => m.id !== reply!.id && m.at >= reply!.at)) return no("The conversation moved on after this answer was written.");
      if (this.s.sends(e.id).some(x => x.step >= 100 && x.at >= reply!.at && x.action_id !== a.id)) return no("This reply was already answered.");
    } else {
      if (!Number.isInteger(d.step) || d.step < 1 || d.step > FOLLOW_UP_DAYS.length + 1) return no("The sequence has four emails at most.");
      if (e && e.state !== "active") return no(`The sequence stopped (${e.reason ?? e.state}).`);
      if (d.step === 1) {
        if (e && e.first_action !== a.id && !this.replaceable(e)) return no("This person is already in this client's campaign.");
      } else {
        if (!e) return no("The first email hasn't been sent.");
        const sends = this.s.sends(e.id);
        previous = sends.find(x => x.step === d.step - 1 && x.state === "sent") ?? null;
        if (!previous) return no("The email before this one isn't confirmed as sent.");
        const due = this.dueAt(d.step, previous.at);
        if (this.now() < due) return no(`Due ${new Date(due).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}.`);
      }
      if (e && this.s.sends(e.id).some(x => x.step === d.step && x.action_id !== a.id)) return no("This step was already sent.");
    }
    if (this.s.mailbox(mailbox)!.health) {
      const cap = this.cap(mailbox);
      if (cap.left <= 0) return no(cap.limit ? `Today's cap of ${cap.limit} is used up.` : cap.reason);
    }
    return { ok: true, value: { draft: d, to, mailbox, enrollment: e, key: sendKey(d.client_id, to, meta?.kind === "reply" ? meta.reply_to : d.step), reply, previous } };
  }
  /** A first draft that was rejected before anything went out doesn't block its replacement. */
  private replaceable(e: Enrollment) {
    const first = this.ledger.getAction(e.first_action);
    return (!first || first.status === "rejected") && !this.s.sends(e.id).length;
  }
  private dueAt(step: number, previousAt: number) {
    return previousAt + (FOLLOW_UP_DAYS[step - 2] - (step > 2 ? FOLLOW_UP_DAYS[step - 3] : 0)) * DAY_MS;
  }

  // ---- sending -----------------------------------------------------------
  private lock(): boolean {
    const held = this.s.one<{ owner: string; pid: number; until: number }>("SELECT owner,pid,until FROM outreach_lease WHERE name='worker'");
    if (held) {
      if (held.until > Date.now() && pidAlive(held.pid)) return false;
      this.s.run("DELETE FROM outreach_lease WHERE name='worker' AND owner=? AND until=?", held.owner, held.until);
    }
    return this.s.run("INSERT OR IGNORE INTO outreach_lease VALUES ('worker',?,?,?)", this.owner, process.pid, Date.now() + LEASE_MS).changes === 1;
  }
  private keepLock() { return this.s.run("UPDATE outreach_lease SET until=? WHERE name='worker' AND owner=?", Date.now() + LEASE_MS, this.owner).changes === 1; }
  private unlock() { this.s.run("DELETE FROM outreach_lease WHERE name='worker' AND owner=?", this.owner); }
  /** One sender at a time, across processes, so a cap can't be overrun by two of them. */
  private async exclusively<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 20_000;
    while (!this.lock()) {
      if (Date.now() > deadline) throw new Error("Outreach is busy. Try again in a moment.");
      await new Promise(r => setTimeout(r, 50));
    }
    try { return await fn(); } finally { this.unlock(); }
  }

  execute(id: string): Promise<SendResult> { return this.exclusively(() => this.send(id)); }

  private async send(id: string): Promise<SendResult> {
    let a = this.ledger.getAction(id);
    if (!a) throw new Error("No such action.");
    const result = (sent: boolean, reason: string | null): SendResult => {
      if (reason) this.s.hold(id, reason, this.now()); else this.s.release(id);
      return { sent, status: this.ledger.getAction(id)!.status, reason };
    };
    if (a.status === "executing") {
      // never runs fn for this status: it only marks a dead sender's action as unknown
      await this.ledger.executeAction(id, async () => { throw new Error("not a send"); });
      a = this.ledger.getAction(id)!;
    }
    if (a.status === "unknown") return result(false, "The last attempt's outcome is unknown. Use Check and retry.");
    if (a.status !== "approved") return { sent: false, status: a.status, reason: a.status === "proposed" ? "It needs approval first." : null };

    let g = this.guard(a);
    if (!g.ok) return result(false, g.reason);
    const { draft, to, mailbox, key } = g.value;
    let e = g.value.enrollment;
    let inReplyTo: string | null = null, references: string | null = null;
    let box: Mailbox;
    try {
      await this.freshHealth(mailbox);
      if (e && draft.step === 1 && e.first_action !== a.id) {
        this.s.run("UPDATE outreach_enrollments SET first_action=?, run_id=?, subject=? WHERE id=?", a.id, a.run_id, draft.subject, e.id);
        e = this.s.enrollmentById(e.id);
      }
      e ??= this.s.enroll({ client_id: draft.client_id, recipient: to, run_id: a.run_id, first_action: a.id, mailbox, since: Math.min(this.now(), Date.parse(a.created_at)), subject: draft.subject });
      // the bug this replaces: look for a reply immediately before every send, and don't send if we couldn't look
      await this.poll(e);
      box = this.box(mailbox, a.run_id);
      const already = await this.findSent(box, e, key);
      if (already) {
        const { ran } = await this.ledger.executeAction(id, async () => ({ message_id: already.id, found_in_sent: true }));
        if (ran) {
          this.recordSent(id, e, draft.step, key, already);
          await this.proposeFollowUp(this.s.enrollmentById(e.id)!);
        }
        return result(false, ran ? "It was already in Sent, so it was recorded and not sent again." : "Another run already handled this email.");
      }
      const reply = g.value.reply, previous = g.value.previous;
      if (reply) inReplyTo = reply.rfc_id ?? (await box.get(reply.id)).headers["message-id"] ?? null;
      if (previous?.message_id) inReplyTo = previous.rfc_id ?? (await box.get(previous.message_id)).headers["message-id"] ?? null;
      if ((reply || previous) && !inReplyTo) return result(false, "The earlier message's id is unreadable, so this can't go in-thread yet.");
      if (inReplyTo) references = [...new Set([...this.s.sends(e.id).map(x => x.rfc_id).filter(Boolean), inReplyTo])].join(" ");
    } catch (err) {
      return result(false, `Not sent, because the checks before sending couldn't finish: ${why(err)}`);
    }

    const current = this.ledger.getAction(id)!;
    g = this.guard(current);
    if (!g.ok) return result(false, g.reason);
    if (g.value.key !== key || g.value.mailbox !== mailbox) return result(false, "The campaign changed during the checks. It will be checked again.");
    if (!this.keepLock()) return result(false, "Another worker took over. It will be checked again.");

    const d = g.value.draft, enrollment = e, threadId = this.s.enrollmentById(e.id)!.thread_id;
    const subject = d.step === 1 && !d.outreach ? d.subject : /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`;
    try {
      const { ran } = await this.ledger.executeAction(id, async claimed => {
        if (claimed.payload.draft_hash !== d.draft_hash) throw new Error("draft changed at the moment of sending");
        this.s.run("DELETE FROM outreach_sends WHERE key=? AND state='not_sent'", key);
        this.s.run("INSERT INTO outreach_sends (action_id,enrollment_id,mailbox,step,key,at,state) VALUES (?,?,?,?,?,?,'attempted')", id, enrollment.id, mailbox, d.step, key, this.now());
        const sent = await box.send({ to, toName: d.to_name, subject, body: outgoingBody(d.body), key, threadId, inReplyTo, references });
        this.recordSent(id, enrollment, d.step, key, { ...sent, at: this.now() });
        return { message_id: sent.id, thread_id: sent.threadId, mailbox, simulated: this.simulated };
      });
      if (!ran) return result(false, "The ledger refused a duplicate of an email already handled.");
    } catch (err) {
      this.alerts.raise(`unknown:${id}:${this.now()}`, `A send needs checking\n${d.company}, email ${d.step}. It will not be retried until Sent has been checked.`);
      return result(false, `The outcome is unknown: ${why(err)}`);
    }
    try {
      const row = this.s.one<SendRow>("SELECT * FROM outreach_sends WHERE action_id=?", id)!;
      this.s.run("UPDATE outreach_sends SET rfc_id=? WHERE action_id=?", (await box.get(row.message_id!)).headers["message-id"] ?? null, id);
    } catch { /* read again before the follow-up */ }
    await this.proposeFollowUp(this.s.enrollmentById(enrollment.id)!);
    return result(true, null);
  }

  private recordSent(action: string, e: Enrollment, step: number, key: string, m: { id: string; threadId: string; at: number }) {
    this.s.run(`INSERT INTO outreach_sends (action_id,enrollment_id,mailbox,step,key,at,state,message_id) VALUES (?,?,?,?,?,?,'sent',?)
      ON CONFLICT(action_id) DO UPDATE SET state='sent', message_id=excluded.message_id, at=excluded.at`, action, e.id, e.mailbox, step, key, m.at, m.id);
    this.s.run("UPDATE outreach_enrollments SET thread_id=COALESCE(thread_id,?) WHERE id=?", m.threadId, e.id);
    if (step === FOLLOW_UP_DAYS.length + 1) this.s.run("UPDATE outreach_enrollments SET state='finished' WHERE id=? AND state='active'", e.id);
  }
  private async findSent(box: Mailbox, e: Enrollment, key: string) {
    for (const hit of await box.search(`in:sent to:"${e.recipient}" after:${Math.floor((e.since - DAY_MS) / 1000)}`)) {
      const m = await box.get(hit.id);
      if (m.headers[KEY_HEADER.toLowerCase()] === key) return m;
    }
    return null;
  }

  /** For an unknown outcome: found in Sent means done. Only a person's click may turn "not found" into a retry. */
  async reconcile(id: string, retry = true): Promise<SendResult> {
    return this.exclusively(() => this.checkUnknown(id, retry));
  }
  private async checkUnknown(id: string, retry: boolean): Promise<SendResult> {
    const a = this.ledger.getAction(id);
    if (a?.status !== "unknown") throw new Error("This action's outcome isn't unknown.");
    const d = a.payload as unknown as Draft, to = address(d.to_email);
    const e = to ? this.s.enrollment(d.client_id, to) : null;
    let found = null;
    const row = this.s.one<SendRow>("SELECT * FROM outreach_sends WHERE action_id=?", id);
    if (e) {
      const key = row?.key ?? sendKey(d.client_id, to, d.outreach?.kind === "reply" ? d.outreach.reply_to : d.step);
      found = await this.findSent(this.box(e.mailbox, a.run_id), e, key);
      if (found) {
        this.ledger.reconcileAction(id, "done");
        this.recordSent(id, e, d.step, key, found);
        await this.proposeFollowUp(this.s.enrollmentById(e.id)!);
        this.s.release(id);
        return { sent: false, status: "executed", reason: "Found in Sent and recorded. Nothing was sent again." };
      }
    }
    if (!retry) return { sent: false, status: "unknown", reason: "Not found in Sent yet." };
    if (row && this.now() - row.at < 120_000) return { sent: false, status: "unknown", reason: "Not in Sent yet. Wait two minutes, because Gmail's search can lag." };
    if (row) this.s.run("UPDATE outreach_sends SET state='not_sent' WHERE action_id=?", id);
    this.ledger.reconcileAction(id, "not-done");
    return this.send(id);
  }

  // ---- replies, bounces, opt-outs ----------------------------------------
  /** Throws if the mailbox couldn't be read completely. Callers must treat that as "don't send". */
  async poll(enrollment: Enrollment) {
    const e = this.s.enrollmentById(enrollment.id)!;
    const box = this.box(e.mailbox, e.run_id);
    const after = `after:${Math.floor(e.since / 1000) - 5}`;
    const theirs = domainOf(e.recipient), ours = domainOf(e.mailbox);
    const queries = [`from:"${e.recipient}" ${after}`, `from:(mailer-daemon OR postmaster) "${e.recipient}" ${after}`];
    // a colleague replying in a new thread also stops it; not searched when the domain is ours or a free-mail one
    if (!FREEMAIL.test(theirs) && theirs !== ours && !theirs.endsWith(`.${ours}`) && !ours.endsWith(`.${theirs}`)) queries.push(`from:"${theirs}" ${after}`);

    const inThread = e.thread_id ? await box.thread(e.thread_id) : [];
    const found = new Map(inThread.map(m => [m.id, m] as const));
    const threadIds = new Set(found.keys());
    const seen = new Set(this.s.inbound(e.id).map(m => m.id));
    for (const q of queries) for (const hit of await box.search(q))
      if (!found.has(hit.id) && !seen.has(hit.id)) found.set(hit.id, await box.get(hit.id));

    for (const m of [...found.values()].sort((x, y) => x.at - y.at)) {
      if (seen.has(m.id) || m.labels.includes("DRAFT") || m.at < e.since - 5000 || m.headers[ALERT_HEADER.toLowerCase()]) continue;
      const from = fromAddress(m);
      let kind: Inbound["kind"] = "reply";
      if (m.labels.includes("SENT") || from === e.mailbox) {
        if (!threadIds.has(m.id) || m.headers[KEY_HEADER.toLowerCase()]) continue;
        kind = "manual"; // a person took over the thread
      } else if (isBounce(from, m.headers)) kind = "bounce";
      const auto = /^auto-(replied|generated)/i.test(m.headers["auto-submitted"] ?? "") || !!m.headers["x-autoreply"];
      const row = this.s.run(`INSERT OR IGNORE INTO outreach_inbound (mailbox,id,enrollment_id,at,from_addr,subject,text,rfc_id,auto,kind) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        e.mailbox, m.id, e.id, m.at, from, (m.headers.subject ?? "").slice(0, 300), m.text.slice(0, 8000), m.headers["message-id"] ?? null, auto ? 1 : 0, kind);
      if (!row.changes) continue;
      // stop first, classify second: a slow or broken model must not let a follow-up out
      this.s.stop(e.id, kind === "bounce" ? "bounced" : kind === "manual" ? "a person took over" : "replied");
    }
    await this.handleNew(this.s.enrollmentById(e.id)!);
  }

  private async handleNew(e: Enrollment) {
    for (const m of this.s.inbound(e.id).filter(x => !x.label)) {
      const first = this.ledger.getAction(e.first_action)?.payload as unknown as Draft | undefined;
      const who = first?.company || e.client_id;
      let label: string, confidence = 1, by = "rule", escalate = false;
      if (m.kind === "manual") label = "manual";
      else if (m.kind === "bounce") {
        const hard = isHardBounce(m.text);
        label = hard ? "bounce" : "bounce_soft";
        if (hard) this.s.suppress(e.recipient, "bounced", this.now());
        this.alerts.raise(`bounce:${m.mailbox}:${m.id}:${e.id}`, `Email bounced: ${who}\nThe follow-ups are stopped.`);
      } else {
        const text = /^\s*(unsubscribe|stop)\s*$/i.test(m.subject) ? "unsubscribe" : m.text;
        const c = await classifyReply(text, { call: makeCall(this.ledger, e.run_id), auto: !!m.auto, names: [first?.to_name, first?.company].filter((x): x is string => !!x), model: this.opts.model });
        ({ label, confidence, by, escalate } = c);
        if (label === "unsubscribe") {
          for (const who_ of new Set([e.recipient, m.from_addr])) if (address(who_) && who_ !== e.mailbox) this.s.suppress(who_, "unsubscribed", this.now());
          for (const other of this.s.all<{ id: string }>("SELECT id FROM outreach_enrollments WHERE recipient=?", e.recipient)) this.s.stop(other.id, "unsubscribed");
        }
        const key = `reply:${m.mailbox}:${m.id}:${e.id}`;
        if (escalate) this.alerts.raise(key, `${label === "interested" ? "Hot lead" : "Reply needs a person"}: ${who}\nLabel: ${label.replaceAll("_", " ")}. Follow-ups are stopped.\nGoal: book the meeting. Open the outreach desk to answer.`);
        else if (label !== "out_of_office") this.alerts.raise(key, `Reply from ${who}: ${label.replaceAll("_", " ")}\nFollow-ups are stopped.`);
        if (first && confidence >= 0.7 && ["interested", "question", "not_now", "out_of_office"].includes(label)) await this.proposeNext(e, first, m, label as ReplyLabel);
      }
      this.s.run(`UPDATE outreach_inbound SET label=?, confidence=?, "by"=? WHERE mailbox=? AND id=? AND enrollment_id=?`, label, confidence, by, m.mailbox, m.id, e.id);
    }
  }

  // ---- drafts this module writes -----------------------------------------
  private propose(e: Enrollment, first: Draft, step: number, body: string, meta: Meta) {
    const subject = /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`;
    const tail = meta.kind === "reply" ? `reply:${meta.reply_to}` : String(step);
    const payload: Draft = {
      lead_id: first.lead_id, client_id: e.client_id, run_id: e.run_id, step, to_name: first.to_name, to_title: first.to_title,
      to_email: e.recipient, to_email_status: first.to_email_status, company: first.company, subject, body, sentences: [],
      draft_hash: draftHash(subject, body), dedupe_key: `outreach:${e.client_id}:${e.recipient}:${tail}`, based_on: [], outreach: meta,
    };
    return this.ledger.proposeAction(e.run_id, "email_draft", `outreach:${e.id}:${tail}`, payload as unknown as Record<string, unknown>);
  }
  facts(client: string): Fact[] { return JSON.parse(this.s.get(`facts:${client}`) ?? "[]"); }
  /** The seller's own product file: one fact a line. Only these may answer a buyer. */
  setFacts(client: string, lines: string[]) {
    const facts = [...new Set(lines.map(l => String(l).replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean))].slice(0, 30)
      .map(text => ({ id: createHash("sha256").update(text).digest("hex").slice(0, 8), text }));
    this.s.set(`facts:${client}`, JSON.stringify(facts));
  }
  private lead(e: Enrollment, first: Draft): { product: string; fit: number | null } {
    const report = this.ledger.stepOutput<any>(e.run_id, "report")?.output;
    const lead = Array.isArray(report?.leads) ? report.leads.find((l: any) => l.lead_id === first.lead_id) : null;
    const fit = Number(lead?.fit_score);
    const product = String(lead?.product ?? this.ledger.getRun(e.run_id)?.request?.product ?? "").replace(/\s+/g, " ").trim();
    return { product: product.slice(0, 80), fit: lead && Number.isFinite(fit) ? Math.max(0, Math.min(100, fit)) : null };
  }
  score(e: Enrollment) {
    const first = this.ledger.getAction(e.first_action)?.payload as unknown as Draft | undefined;
    const sends = this.s.sends(e.id).filter(x => x.state === "sent");
    const replies = this.s.inbound(e.id).map(m => {
      const before = sends.filter(x => x.at <= m.at).at(-1);
      return { label: m.label, hours: before ? (m.at - before.at) / 3_600_000 : Infinity };
    });
    return leadScore({ fit: first ? this.lead(e, first).fit : null, sent: sends.filter(x => x.step < 100).length, replies, booked: e.state === "booked" });
  }
  /** Conversation memory in, a checked plan out. */
  private async plan(e: Enrollment, first: Draft, step: number, reply: ReplyLabel | null): Promise<{ plan: Plan; body: string }> {
    const sent = this.s.sends(e.id).filter(x => x.state === "sent");
    const turns: { who: "us" | "them"; at: number; text: string }[] = [];
    const angles: Angle[] = [], used: string[] = [];
    for (const x of sent) {
      const d = this.ledger.getAction(x.action_id)?.payload as unknown as Draft | undefined;
      if (!d) continue;
      turns.push({ who: "us", at: x.at, text: d.body });
      if (d.outreach?.plan) { angles.push(d.outreach.plan.angle); used.push(...d.outreach.plan.fact_ids); }
    }
    for (const m of this.s.inbound(e.id)) turns.push({ who: m.kind === "manual" ? "us" : "them", at: m.at, text: newText(m.text) });
    turns.sort((a, b) => a.at - b.at);
    const { product } = this.lead(e, first), facts = this.facts(e.client_id), start = turns[0]?.at ?? this.now();
    const plan = await nextAction({
      product, facts, step, reply, score: this.score(e).score, used: { angles, fact_ids: used },
      turns: turns.map(t => ({ who: t.who, day: Math.round((t.at - start) / DAY_MS), text: t.text })),
    }, { call: makeCall(this.ledger, e.run_id), now: this.now(), names: [first.to_name, first.company].filter(Boolean), model: this.opts.planner });
    const body = compose(plan, { first: String(first.to_name || "").trim().split(/\s+/)[0], company: first.company, product, facts, link: this.s.campaign(e.client_id).booking_url });
    return { plan, body };
  }
  private async proposeFollowUp(e: Enrollment) {
    if (e.state !== "active") return;
    const sent = this.s.sends(e.id).filter(x => x.state === "sent" && x.step < 100);
    const step = Math.max(0, ...sent.map(x => x.step)) + 1;
    if (step < 2 || step > FOLLOW_UP_DAYS.length + 1 || this.ledger.getActionByKey(`outreach:${e.id}:${step}`)) return;
    // a follow-up the writing agent proposed takes the place of ours
    const theirs = this.s.one(`SELECT id FROM actions WHERE kind='email_draft' AND json_extract(payload_json,'$.client_id')=? AND lower(json_extract(payload_json,'$.to_email'))=?
      AND json_extract(payload_json,'$.step')=?`, e.client_id, e.recipient, step);
    const first = this.ledger.getAction(e.first_action)?.payload as unknown as Draft | undefined;
    if (theirs || !first) return;
    const { plan, body } = await this.plan(e, first, step, null);
    const needs_person = plan.action === "escalate";
    if (needs_person) this.alerts.raise(`next:${e.id}:${step}`, `Next step needs a person: ${first.company}\n${plan.reason}`);
    this.propose(e, first, step, body, { kind: "follow_up", enrollment_id: e.id, plan, needs_person });
  }
  private async proposeNext(e: Enrollment, first: Draft, m: Inbound, label: ReplyLabel) {
    if (e.reason !== "replied" || this.ledger.getActionByKey(`outreach:${e.id}:reply:${m.id}`)) return;
    const { plan, body } = await this.plan(e, first, 0, label);
    if (plan.action === "escalate" || plan.action === "stop") {
      this.alerts.raise(`next:${m.mailbox}:${m.id}:${e.id}`, `Next step needs a person: ${first.company}\n${plan.reason}`);
      return;
    }
    const not_before = plan.action === "wait" ? m.at + (plan.delay_days ?? 30) * DAY_MS : undefined;
    const text = m.from_addr === e.recipient ? body : body.replace(/^Hi [^\n]*,/, "Hello,");
    const n = this.s.one<{ n: number }>("SELECT rowid n FROM outreach_inbound WHERE mailbox=? AND id=? AND enrollment_id=?", m.mailbox, m.id, e.id)!.n;
    this.propose(e, first, 100 + n, text, { kind: "reply", enrollment_id: e.id, reply_to: m.id, plan, not_before, needs_person: true });
  }

  // ---- the worker --------------------------------------------------------
  drafts(...status: string[]): ProposedAction[] {
    const ids = this.s.all<{ id: string }>(`SELECT id FROM actions WHERE kind='email_draft' AND status IN (${status.map(() => "?").join(",")}) ORDER BY created_at`, ...status);
    return ids.map(r => this.ledger.getAction(r.id)!);
  }
  async tick(): Promise<{ busy: boolean; polled: number; sent: number; errors: number }> {
    const out = { busy: false, polled: 0, sent: 0, errors: 0 };
    if (!this.lock()) return { ...out, busy: true };
    try {
      for (const e of this.s.enrollments().filter(x => x.state === "active" || this.now() - x.since < 45 * DAY_MS)) {
        this.keepLock();
        try { await this.poll(e); out.polled++; }
        catch (err) {
          out.errors++;
          this.alerts.raise(`read:${e.mailbox}:${budgetDay(new Date(this.now()))}`, `Can't read replies in ${e.mailbox}\nIts follow-ups are held until it can be read. ${why(err)}`);
        }
        await this.proposeFollowUp(this.s.enrollmentById(e.id)!);
      }
      for (const a of this.drafts("executing")) await this.send(a.id);
      for (const a of this.drafts("unknown")) {
        this.keepLock();
        try { await this.checkUnknown(a.id, false); } catch { out.errors++; }
      }
      for (const a of this.drafts("proposed")) {
        const d = a.payload as unknown as Draft;
        // an answer to a person is never sent without a person, in either mode
        if (d.outreach?.kind === "reply" || d.outreach?.needs_person || typeof d.client_id !== "string") continue;
        if (this.s.campaign(d.client_id).mode !== "auto") continue;
        const g = this.guard(a);
        if (g.ok) this.ledger.decideAction(a.id, "approved", "policy:full-auto");
        else this.s.hold(a.id, g.reason, this.now());
      }
      // the cap goes to answers first, then to the strongest leads, then to follow-ups before new leads
      const rank = new Map(this.drafts("approved").map(a => {
        const d = a.payload as unknown as Draft, to = address(d.to_email), e = to ? this.s.enrollment(d.client_id ?? "", to) : null;
        return [a, (d.outreach?.kind === "reply" ? 10_000 : 0) + (e ? this.score(e).score * 10 + 1 : 500) + (Number(d.step) || 0)] as const;
      }));
      const queue = [...rank.keys()].sort((x, y) => rank.get(y)! - rank.get(x)!);
      for (const a of queue) {
        this.keepLock();
        if ((await this.send(a.id)).sent) out.sent++;
      }
      for (const a of this.drafts("proposed")) {
        const d = a.payload as unknown as Draft;
        if (d.outreach?.kind === "follow_up" && this.s.campaign(d.client_id).mode === "approval" && this.guard(a).ok)
          this.alerts.raise(`approve:${a.id}`, `Follow-up waiting for approval\n${d.company}, email ${d.step}.`);
      }
      const ist = new Date(this.now() + 330 * 60_000);
      if (ist.getUTCHours() >= 9 && this.s.enrollments().some(e => e.state === "active"))
        this.alerts.raise(`status:${budgetDay(new Date(this.now()))}`, this.statusText());
      await this.alerts.flush();
      this.s.set("last_tick", new Date().toISOString());
      return out;
    } finally { this.unlock(); }
  }

  // ---- what a person can do ----------------------------------------------
  approve(id: string, hash: string) {
    const a = this.ledger.getAction(id);
    if (!a || a.kind !== "email_draft") throw new Error("No such draft.");
    if (a.payload.draft_hash !== hash || draftHash(String(a.payload.subject), String(a.payload.body)) !== hash) throw new Error("The draft changed. Reload and read it again.");
    this.ledger.decideAction(id, "approved");
  }
  reject(id: string) {
    const a = this.ledger.getAction(id);
    if (!a || a.kind !== "email_draft") throw new Error("No such draft.");
    this.ledger.decideAction(id, "rejected");
    const m = (a.payload as unknown as Draft).outreach;
    if (m?.kind === "follow_up") this.s.stop(m.enrollment_id, "follow-up declined");
  }
  markBooked(enrollment: string) {
    const e = this.s.enrollmentById(enrollment);
    if (!e) throw new Error("No such conversation.");
    this.s.run("UPDATE outreach_enrollments SET state='booked', reason='meeting booked' WHERE id=?", e.id);
    const first = this.ledger.getAction(e.first_action)?.payload as any;
    this.alerts.raise(`booked:${e.id}`, `Meeting booked: ${first?.company ?? e.client_id}`);
  }
  statusText(): string {
    const all = this.s.enrollments();
    const n = (f: (e: Enrollment) => boolean) => all.filter(f).length;
    const sent = this.s.one<{ n: number }>("SELECT COUNT(*) n FROM outreach_sends WHERE state='sent'")!.n;
    return `Outreach status\n${sent} sent, ${n(e => e.state === "active")} in sequence, ${n(e => e.reason === "replied")} replied, ${n(e => e.state === "booked")} meetings booked, ${this.openDrafts("proposed").length} waiting for approval.`;
  }

  /** Drafts a person can still act on: a stopped sequence's follow-ups don't count. */
  private openDrafts(...status: string[]) {
    return this.drafts(...status).filter(a => {
      const m = (a.payload as unknown as Draft).outreach;
      return !m || m.kind === "reply" || a.status === "unknown" || this.s.enrollmentById(m.enrollment_id)?.state === "active";
    });
  }
  snapshot() {
    const clients = this.s.all<{ c: string }>(`SELECT DISTINCT json_extract(payload_json,'$.client_id') c FROM actions WHERE kind='email_draft' AND json_extract(payload_json,'$.client_id') IS NOT NULL
      UNION SELECT client_id FROM outreach_campaigns`).map(r => String(r.c));
    const hold = new Map(this.s.all<{ action_id: string; reason: string }>("SELECT * FROM outreach_holds").map(h => [h.action_id, h.reason]));
    return {
      simulated: this.simulated, now: new Date(this.now()).toISOString(), last_tick: this.s.get("last_tick"),
      test_recipients: [...testRecipients()], channels: this.alerts.state(),
      mailboxes: this.usableMailboxes().map(m => ({ email: m.email, manual_cap: m.cap, selector: m.dkim_selector, health: m.health ? JSON.parse(m.health) : null, cap: this.cap(m.email) })),
      campaigns: clients.map(c => ({ ...this.s.campaign(c), product_facts: this.facts(c) })),
      conversations: this.s.enrollments().map(e => {
        const first = this.ledger.getAction(e.first_action)?.payload as any;
        const sends = this.s.sends(e.id), steps = sends.filter(x => x.state === "sent" && x.step < 100), last = steps.at(-1);
        return {
          id: e.id, client_id: e.client_id, company: first?.company ?? "", recipient: e.recipient, state: e.state, reason: e.reason,
          sent: steps.length, total: FOLLOW_UP_DAYS.length + 1,
          next_due: e.state === "active" && last && last.step <= FOLLOW_UP_DAYS.length ? this.dueAt(last.step + 1, last.at) : null,
          ...this.score(e),
          replies: this.s.inbound(e.id).map(m => ({ id: m.id, at: m.at, kind: m.kind, label: m.label, confidence: m.confidence, by: m.by, from: m.from_addr, text: newText(m.text).slice(0, 600) })),
        };
      }),
      drafts: this.openDrafts("proposed", "approved", "executing", "unknown").map(a => {
        const d = a.payload as unknown as Draft, g = this.guard(a);
        return {
          id: a.id, status: a.status, client_id: d.client_id, company: d.company, to: d.to_email, step: d.step, kind: d.outreach?.kind ?? "draft",
          subject: d.subject, body: outgoingBody(String(d.body ?? "")), hash: d.draft_hash,
          plan: d.outreach?.plan ?? null, not_before: d.outreach?.not_before ?? null, needs_person: !!d.outreach?.needs_person,
          blocked: !g.ok ? g.reason : a.status === "approved" || a.status === "unknown" ? hold.get(a.id) ?? null : null,
        };
      }),
      alerts: this.s.all<any>("SELECT d.key, d.text, d.at, t.state telegram, e.state email FROM outreach_alerts d LEFT JOIN outreach_alerts t ON t.key=d.key AND t.channel='telegram' LEFT JOIN outreach_alerts e ON e.key=d.key AND e.channel='email' WHERE d.channel='desk' ORDER BY d.at DESC LIMIT 30"),
      totals: {
        sent: this.s.one<{ n: number }>("SELECT COUNT(*) n FROM outreach_sends WHERE state='sent'")!.n,
        suppressed: this.s.one<{ n: number }>("SELECT COUNT(*) n FROM outreach_suppressed")!.n,
      },
    };
  }
}
