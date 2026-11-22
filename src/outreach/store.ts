import type { Ledger } from "../ledger/ledger.js";
import { randomUUID } from "node:crypto";

export type Mode = "approval" | "auto";
export interface Campaign { client_id: string; mailbox: string | null; mode: Mode; paused: number; booking_url: string | null }
export interface Enrollment {
  id: string; client_id: string; recipient: string; run_id: string; first_action: string; mailbox: string;
  since: number; thread_id: string | null; subject: string; state: "active" | "stopped" | "booked" | "finished";
  reason: string | null;
}
export interface SendRow {
  action_id: string; enrollment_id: string; mailbox: string; step: number; key: string; at: number;
  state: "attempted" | "sent" | "not_sent"; message_id: string | null; rfc_id: string | null;
}
export interface MailboxRow { email: string; transport: "gmail" | "simulated"; token: string | null; connected_at: number; cap: number | null; health: string | null; dkim_selector: string | null }
export interface Inbound { mailbox: string; id: string; enrollment_id: string; at: number; from_addr: string; subject: string; text: string; rfc_id: string | null; auto: number; kind: "reply" | "bounce" | "manual"; label: string | null; confidence: number | null; by: string | null }

const ready = new WeakMap<Ledger, Store>();
export function store(ledger: Ledger): Store {
  let s = ready.get(ledger);
  if (!s) ready.set(ledger, (s = new Store(ledger)));
  return s;
}

/** Outreach's own tables, in the ledger's database. The actions table stays the authority on approval and sending. */
export class Store {
  constructor(readonly ledger: Ledger) {
    ledger.db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_mailboxes (email TEXT PRIMARY KEY, transport TEXT NOT NULL, token TEXT, connected_at INTEGER NOT NULL, cap INTEGER, health TEXT, dkim_selector TEXT);
      CREATE TABLE IF NOT EXISTS outreach_campaigns (client_id TEXT PRIMARY KEY, mailbox TEXT, mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('approval','auto')), paused INTEGER NOT NULL DEFAULT 0, booking_url TEXT);
      CREATE TABLE IF NOT EXISTS outreach_enrollments (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, recipient TEXT NOT NULL, run_id TEXT NOT NULL, first_action TEXT NOT NULL,
        mailbox TEXT NOT NULL, since INTEGER NOT NULL, thread_id TEXT, subject TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, UNIQUE(client_id, recipient));
      CREATE TABLE IF NOT EXISTS outreach_sends (action_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, mailbox TEXT NOT NULL, step INTEGER NOT NULL, key TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL, state TEXT NOT NULL, message_id TEXT, rfc_id TEXT, UNIQUE(enrollment_id, step));
      CREATE INDEX IF NOT EXISTS outreach_sends_day ON outreach_sends(mailbox, at);
      CREATE TABLE IF NOT EXISTS outreach_inbound (mailbox TEXT, id TEXT, enrollment_id TEXT, at INTEGER, from_addr TEXT, subject TEXT, text TEXT, rfc_id TEXT, auto INTEGER, kind TEXT, label TEXT, confidence REAL, "by" TEXT,
        PRIMARY KEY(mailbox, id, enrollment_id));
      CREATE TABLE IF NOT EXISTS outreach_suppressed (email TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_alerts (key TEXT, channel TEXT, text TEXT, state TEXT, attempts INTEGER DEFAULT 0, error TEXT, at INTEGER, PRIMARY KEY(key, channel));
      CREATE TABLE IF NOT EXISTS outreach_holds (action_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, until INTEGER NOT NULL);
    `);
  }
  private get db() { return this.ledger.db; }
  all<T>(sql: string, ...args: any[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  one<T>(sql: string, ...args: any[]): T | null { return (this.db.prepare(sql).get(...args) as T | undefined) ?? null; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }

  get(key: string) { return this.one<{ value: string }>("SELECT value FROM outreach_settings WHERE key=?", key)?.value ?? null; }
  set(key: string, value: string) { this.run("INSERT INTO outreach_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }

  mailboxes() { return this.all<MailboxRow>("SELECT * FROM outreach_mailboxes ORDER BY connected_at"); }
  mailbox(email: string) { return this.one<MailboxRow>("SELECT * FROM outreach_mailboxes WHERE email=?", email); }
  saveMailbox(email: string, transport: MailboxRow["transport"], token: string | null, at = Date.now()) {
    this.run("INSERT INTO outreach_mailboxes (email,transport,token,connected_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET transport=excluded.transport, token=excluded.token", email, transport, token, at);
  }

  campaign(client: string): Campaign {
    this.run("INSERT OR IGNORE INTO outreach_campaigns (client_id) VALUES (?)", client);
    return this.one<Campaign>("SELECT * FROM outreach_campaigns WHERE client_id=?", client)!;
  }
  enrollment(client: string, recipient: string) { return this.one<Enrollment>("SELECT * FROM outreach_enrollments WHERE client_id=? AND recipient=?", client, recipient); }
  enrollmentById(id: string) { return this.one<Enrollment>("SELECT * FROM outreach_enrollments WHERE id=?", id); }
  enrollments() { return this.all<Enrollment>("SELECT * FROM outreach_enrollments ORDER BY since DESC"); }
  enroll(e: Omit<Enrollment, "id" | "state" | "reason" | "thread_id">): Enrollment {
    this.run("INSERT OR IGNORE INTO outreach_enrollments (id,client_id,recipient,run_id,first_action,mailbox,since,subject,state) VALUES (?,?,?,?,?,?,?,?,'active')",
      randomUUID(), e.client_id, e.recipient, e.run_id, e.first_action, e.mailbox, e.since, e.subject);
    return this.enrollment(e.client_id, e.recipient)!;
  }
  /** The first reason sticks, except that an opt-out or bounce outranks an ordinary stop. */
  stop(id: string, reason: string) {
    this.run(`UPDATE outreach_enrollments SET state=CASE WHEN state='booked' THEN state ELSE 'stopped' END, reason=?
      WHERE id=? AND (state IN ('active','finished') OR ? IN ('unsubscribed','bounced'))`, reason, id, reason);
  }
  sends(enrollment: string) { return this.all<SendRow>("SELECT * FROM outreach_sends WHERE enrollment_id=? AND state<>'not_sent' ORDER BY step", enrollment); }
  inbound(enrollment: string) { return this.all<Inbound>("SELECT * FROM outreach_inbound WHERE enrollment_id=? ORDER BY at", enrollment); }

  suppressed(email: string) { return this.one<{ reason: string }>("SELECT reason FROM outreach_suppressed WHERE email=?", email); }
  suppress(email: string, reason: string, at: number) { this.run("INSERT OR IGNORE INTO outreach_suppressed VALUES (?,?,?)", email, reason, at); }

  hold(action: string, reason: string, at: number) { this.run("INSERT INTO outreach_holds VALUES (?,?,?) ON CONFLICT(action_id) DO UPDATE SET reason=excluded.reason, at=excluded.at", action, reason, at); }
  release(action: string) { this.run("DELETE FROM outreach_holds WHERE action_id=?", action); }
}
