import { randomUUID, createHash } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import { budgetDay, envLimit } from "../core/limits.js";
import { BudgetExceeded } from "../core/types.js";
import type { Kind, Limits, Props } from "./adapter.js";
import type { SyncLead } from "./mapping.js";

export interface Link {
  lead_id: string; kind: Kind; remote_id: string; natural: string; state: "active" | "paused";
  pushed: Props; held: string[];
}
export type ConflictType = "field" | "duplicate" | "person" | "delete" | "merge";
export interface Conflict {
  id: string; type: ConflictType; lead_id: string; company: string; kind: Kind; field: string;
  remote_id: string; ours: string; theirs: string; status: "open" | "approved" | "rejected"; created_at: number;
}
export interface Job { lead_id: string; run_id: string; lead: SyncLead; attempts: number }

/** CRM sync state, in the same sqlite file as the run ledger. One namespace per adapter. */
export class Store {
  constructor(readonly ledger: Ledger, readonly crm: string, private provider: string, private limits: Limits) {
    ledger.db.exec(`
      CREATE TABLE IF NOT EXISTS crm_meta (crm TEXT, key TEXT, value TEXT, PRIMARY KEY (crm, key));
      CREATE TABLE IF NOT EXISTS crm_outbox (
        crm TEXT, lead_id TEXT, client_id TEXT NOT NULL, run_id TEXT NOT NULL, lead_json TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (crm, lead_id));
      CREATE TABLE IF NOT EXISTS crm_links (
        crm TEXT, lead_id TEXT, kind TEXT, remote_id TEXT NOT NULL, natural_key TEXT NOT NULL, state TEXT NOT NULL,
        pushed_json TEXT NOT NULL, held_json TEXT NOT NULL, PRIMARY KEY (crm, lead_id, kind));
      CREATE INDEX IF NOT EXISTS crm_links_remote ON crm_links(crm, kind, remote_id);
      CREATE TABLE IF NOT EXISTS crm_associations (crm TEXT, a TEXT, b TEXT, PRIMARY KEY (crm, a, b));
      CREATE TABLE IF NOT EXISTS crm_events (crm TEXT, id TEXT, at INTEGER, received_at INTEGER, PRIMARY KEY (crm, id));
      CREATE TABLE IF NOT EXISTS crm_values (
        crm TEXT, kind TEXT, remote_id TEXT, field TEXT, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (crm, kind, remote_id, field));
      CREATE TABLE IF NOT EXISTS crm_conflicts (
        id TEXT PRIMARY KEY, crm TEXT, type TEXT, lead_id TEXT, kind TEXT, field TEXT, remote_id TEXT,
        ours TEXT, theirs TEXT, status TEXT, created_at INTEGER, decided_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS crm_conflicts_open ON crm_conflicts(crm, type, lead_id, kind, field) WHERE status='open';
      CREATE TABLE IF NOT EXISTS crm_usage (id INTEGER PRIMARY KEY, crm TEXT, run_id TEXT, day TEXT);
      CREATE INDEX IF NOT EXISTS crm_usage_day ON crm_usage(crm, day);
      CREATE TABLE IF NOT EXISTS crm_lock (crm TEXT PRIMARY KEY, owner TEXT NOT NULL, until_at INTEGER NOT NULL);
    `);
    for (const column of ["units REAL NOT NULL DEFAULT 1", "at INTEGER NOT NULL DEFAULT 0"])
      try { ledger.db.exec(`ALTER TABLE crm_usage ADD COLUMN ${column}`); } catch { /* column exists */ }
  }
  private sql(q: string) { return this.ledger.db.prepare(q); }
  atomic<T>(fn: () => T): T {
    this.ledger.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.ledger.db.exec("COMMIT"); return out; } catch (e) { this.ledger.db.exec("ROLLBACK"); throw e; }
  }

  meta(key: string): string { return (this.sql(`SELECT value FROM crm_meta WHERE crm=? AND key=?`).get(this.crm, key) as any)?.value ?? ""; }
  setMeta(key: string, value: string) { this.sql(`INSERT INTO crm_meta VALUES (?,?,?) ON CONFLICT DO UPDATE SET value=excluded.value`).run(this.crm, key, value); }

  // ---- hard caps: counted before the request, so a crash still counts
  private dayCap() {
    const name = this.provider === "zoho" ? "CRM_ZOHO_DAILY_CREDIT_LIMIT" : "CRM_DAILY_CALL_LIMIT";
    return { name, cap: envLimit(name, this.limits.day) };
  }
  private usedToday(): number {
    const row = this.limits.rolling
      ? this.sql(`SELECT COALESCE(SUM(units),0) n FROM crm_usage WHERE crm=? AND at>?`).get(this.crm, Date.now() - 86_400_000)
      : this.sql(`SELECT COALESCE(SUM(units),0) n FROM crm_usage WHERE crm=? AND day=?`).get(this.crm, budgetDay());
    return Number((row as any).n);
  }
  reserveCall(runId: string, units = 1) {
    this.atomic(() => {
      const refuse = (name: string, cap: number) => new BudgetExceeded("credits", `${name} ${cap} blocks this CRM call; queued work is kept`);
      // polling has no run, so only the daily cap applies to it
      if (runId !== "crm-poll") {
        const cap = envLimit("CRM_RUN_CALL_LIMIT", this.limits.run);
        const used = Number((this.sql(`SELECT COALESCE(SUM(units),0) n FROM crm_usage WHERE crm=? AND run_id=?`).get(this.crm, runId) as any).n);
        if (used + units > cap) throw refuse("CRM_RUN_CALL_LIMIT", cap);
      }
      const { name, cap } = this.dayCap();
      if (this.usedToday() + units > cap) throw refuse(name, cap);
      this.sql(`INSERT INTO crm_usage (crm, run_id, day, units, at) VALUES (?,?,?,?,?)`).run(this.crm, runId, budgetDay(), units, Date.now());
    });
  }
  callsToday() {
    return { used: this.usedToday(), limit: this.dayCap().cap, window: this.limits.rolling ? "24 hours" : "day, IST", unit: this.provider === "zoho" ? "credits" : "calls" };
  }

  // ---- one worker per CRM, across processes
  tryLock(owner: string): boolean {
    return this.sql(`INSERT INTO crm_lock VALUES (?,?,?) ON CONFLICT(crm) DO UPDATE SET owner=excluded.owner, until_at=excluded.until_at
      WHERE crm_lock.until_at < ? OR crm_lock.owner=excluded.owner`).run(this.crm, owner, Date.now() + 60_000, Date.now()).changes > 0;
  }
  unlock(owner: string) { this.sql(`DELETE FROM crm_lock WHERE crm=? AND owner=?`).run(this.crm, owner); }

  // ---- outbox: one row per lead holding the latest desired state
  enqueue(runId: string, lead: SyncLead) {
    this.atomic(() => {
      const old = this.sql(`SELECT client_id FROM crm_outbox WHERE crm=? AND lead_id=?`).get(this.crm, lead.lead_id) as any;
      if (old && old.client_id !== lead.client_id) throw new Error("lead_id already belongs to another client");
      this.sql(`INSERT INTO crm_outbox VALUES (?,?,?,?,?,'pending',0,0,NULL,?) ON CONFLICT(crm, lead_id) DO UPDATE SET
        run_id=excluded.run_id, lead_json=excluded.lead_json, state='pending', attempts=0, next_at=0, error=NULL, updated_at=excluded.updated_at`)
        .run(this.crm, lead.lead_id, lead.client_id, runId, JSON.stringify(lead), Date.now());
    });
  }
  /** Only the lock holder claims, so a row left in_flight belongs to a worker that died. */
  recoverInFlight() { this.sql(`UPDATE crm_outbox SET state='pending' WHERE crm=? AND state='in_flight'`).run(this.crm); }
  claim(): Job | null {
    return this.atomic(() => {
      const r = this.sql(`SELECT * FROM crm_outbox WHERE crm=? AND state IN ('pending','retry') AND next_at<=? ORDER BY updated_at, rowid LIMIT 1`).get(this.crm, Date.now()) as any;
      if (!r) return null;
      this.sql(`UPDATE crm_outbox SET state='in_flight' WHERE crm=? AND lead_id=?`).run(this.crm, r.lead_id);
      return { lead_id: r.lead_id, run_id: r.run_id, lead: JSON.parse(r.lead_json), attempts: r.attempts };
    });
  }
  /** A newer enqueue during the write turns the row back to pending, and this leaves that alone. */
  settle(job: Job, state: "done" | "review" | "retry" | "failed" | "pending", error: string | null = null, nextAt = 0) {
    this.sql(`UPDATE crm_outbox SET state=?, error=?, next_at=?, attempts=attempts+?, updated_at=? WHERE crm=? AND lead_id=? AND state='in_flight'`)
      .run(state, error, nextAt, error ? 1 : 0, Date.now(), this.crm, job.lead_id);
  }
  desired(leadId: string): SyncLead | null {
    const r = this.sql(`SELECT lead_json FROM crm_outbox WHERE crm=? AND lead_id=?`).get(this.crm, leadId) as any;
    return r ? JSON.parse(r.lead_json) : null;
  }
  requeue(leadId: string) { this.sql(`UPDATE crm_outbox SET state='pending', attempts=0, next_at=0, error=NULL WHERE crm=? AND lead_id=?`).run(this.crm, leadId); }
  requeueFailed() { this.sql(`UPDATE crm_outbox SET state='pending', attempts=0, next_at=0, error=NULL WHERE crm=? AND state IN ('retry','failed')`).run(this.crm); }
  settled(): { run_id: string; lead: SyncLead }[] {
    return (this.sql(`SELECT run_id, lead_json FROM crm_outbox WHERE crm=? AND state IN ('done','review')`).all(this.crm) as any[]).map(r => ({ run_id: r.run_id, lead: JSON.parse(r.lead_json) }));
  }
  /** Leads queued before any CRM was connected follow the one that gets connected. */
  adoptQueue(from: string) {
    if (this.sql(`SELECT 1 FROM crm_links WHERE crm=? LIMIT 1`).get(from)) return;
    this.sql(`UPDATE OR IGNORE crm_outbox SET crm=? WHERE crm=? AND state<>'in_flight'`).run(this.crm, from);
  }
  sharedWith(provider: string, account: string): string | null {
    const r = this.sql(`SELECT a.crm FROM crm_meta a JOIN crm_meta p ON p.crm=a.crm AND p.key='provider'
      WHERE a.key='account' AND a.value=? AND p.value=? AND a.crm<>? AND a.crm LIKE '%@%' LIMIT 1`).get(account, provider, this.crm) as any;
    return r?.crm ?? null;
  }
  outbox(): { lead_id: string; company: string; state: string; attempts: number; error: string | null }[] {
    return this.sql(`SELECT lead_id, json_extract(lead_json,'$.company') company, state, attempts, error FROM crm_outbox WHERE crm=? ORDER BY updated_at DESC`).all(this.crm) as any;
  }

  // ---- links
  private toLink = (r: any): Link => ({ lead_id: r.lead_id, kind: r.kind, remote_id: r.remote_id, natural: r.natural_key, state: r.state, pushed: JSON.parse(r.pushed_json), held: JSON.parse(r.held_json) });
  link(leadId: string, kind: Kind): Link | null {
    const r = this.sql(`SELECT * FROM crm_links WHERE crm=? AND lead_id=? AND kind=?`).get(this.crm, leadId, kind);
    return r ? this.toLink(r) : null;
  }
  links(kind: Kind, remoteId?: string): Link[] {
    const rows = remoteId === undefined ? this.sql(`SELECT * FROM crm_links WHERE crm=? AND kind=?`).all(this.crm, kind)
      : this.sql(`SELECT * FROM crm_links WHERE crm=? AND kind=? AND remote_id=?`).all(this.crm, kind, remoteId);
    return rows.map(this.toLink);
  }
  linkByNatural(kind: Kind, natural: string): Link | null {
    if (!natural) return null;
    const r = this.sql(`SELECT * FROM crm_links WHERE crm=? AND kind=? AND natural_key=? AND state='active' LIMIT 1`).get(this.crm, kind, natural);
    return r ? this.toLink(r) : null;
  }
  saveLink(l: Link) {
    this.sql(`INSERT INTO crm_links VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET
      remote_id=excluded.remote_id, natural_key=excluded.natural_key, state=excluded.state, pushed_json=excluded.pushed_json, held_json=excluded.held_json`)
      .run(this.crm, l.lead_id, l.kind, l.remote_id, l.natural, l.state, JSON.stringify(l.pushed), JSON.stringify(l.held));
  }
  paused(): { lead_id: string; kind: Kind; remote_id: string; company: string }[] {
    return this.sql(`SELECT l.lead_id, l.kind, l.remote_id, json_extract(o.lead_json,'$.company') company FROM crm_links l
      LEFT JOIN crm_outbox o ON o.crm=l.crm AND o.lead_id=l.lead_id WHERE l.crm=? AND l.state='paused'`).all(this.crm) as any;
  }
  dropLink(leadId: string, kind: Kind) { this.sql(`DELETE FROM crm_links WHERE crm=? AND lead_id=? AND kind=?`).run(this.crm, leadId, kind); }
  isAssociated(a: string, b: string) { return !!this.sql(`SELECT 1 FROM crm_associations WHERE crm=? AND a=? AND b=?`).get(this.crm, a, b); }
  associated(a: string, b: string) { this.sql(`INSERT OR IGNORE INTO crm_associations VALUES (?,?,?)`).run(this.crm, a, b); }

  // ---- inbound: each event id applies once, and an older one never overwrites a newer one
  applyEvent(kind: Kind, remoteId: string, field: string, value: string, at: number): boolean {
    const id = createHash("sha256").update(JSON.stringify([kind, remoteId, field, at, value])).digest("hex");
    return this.atomic(() => {
      if (!this.sql(`INSERT OR IGNORE INTO crm_events VALUES (?,?,?,?)`).run(this.crm, id, at, Date.now()).changes) return false;
      return this.sql(`INSERT INTO crm_values VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET value=excluded.value, at=excluded.at WHERE excluded.at >= crm_values.at`)
        .run(this.crm, kind, remoteId, field, value, at).changes > 0;
    });
  }
  values(kind: Kind, remoteId: string): Props {
    return Object.fromEntries((this.sql(`SELECT field, value FROM crm_values WHERE crm=? AND kind=? AND remote_id=?`).all(this.crm, kind, remoteId) as any[]).map(r => [r.field, r.value]));
  }

  // ---- decisions for a person
  openConflict(c: Pick<Conflict, "type" | "lead_id" | "kind"> & Partial<Pick<Conflict, "field" | "remote_id" | "ours" | "theirs">>) {
    const field = c.field ?? "", remote = c.remote_id ?? "", ours = c.ours ?? "", theirs = c.theirs ?? "";
    const old = this.conflictFor(c.lead_id, c.kind, c.type, field);
    // changed facts get a new id, so a person can only approve what was shown to them
    if (old?.remote_id === remote && old.ours === ours && old.theirs === theirs) return;
    this.atomic(() => {
      this.sql(`DELETE FROM crm_conflicts WHERE crm=? AND type=? AND lead_id=? AND kind=? AND field=? AND status='open'`).run(this.crm, c.type, c.lead_id, c.kind, field);
      this.sql(`INSERT INTO crm_conflicts VALUES (?,?,?,?,?,?,?,?,?,'open',?,NULL)`).run(randomUUID(), this.crm, c.type, c.lead_id, c.kind, field, remote, ours, theirs, Date.now());
    });
  }
  private conflictFor(leadId: string, kind: Kind, type: ConflictType, field: string) {
    return this.sql(`SELECT * FROM crm_conflicts WHERE crm=? AND lead_id=? AND kind=? AND type=? AND field=? AND status='open'`).get(this.crm, leadId, kind, type, field) as unknown as Conflict | undefined;
  }
  /** A field edit that was undone, or now agrees with us, needs no decision. */
  clearField(leadId: string, kind: Kind, field: string) {
    this.sql(`DELETE FROM crm_conflicts WHERE crm=? AND type='field' AND lead_id=? AND kind=? AND field=? AND status='open'`).run(this.crm, leadId, kind, field);
  }
  clearPerson(leadId: string) {
    this.sql(`DELETE FROM crm_conflicts WHERE crm=? AND type='person' AND lead_id=? AND status='open'`).run(this.crm, leadId);
  }
  /** An undecided delete, merge or duplicate stops writes to that record. A change of person is checked again each push. */
  awaitingPerson(leadId: string, kind: Kind) {
    return !!this.sql(`SELECT 1 FROM crm_conflicts WHERE crm=? AND lead_id=? AND kind=? AND type NOT IN ('field','person') AND status='open'`).get(this.crm, leadId, kind);
  }
  conflict(id: string) { return this.sql(`SELECT * FROM crm_conflicts WHERE crm=? AND id=?`).get(this.crm, id) as unknown as Conflict | undefined; }
  openConflicts(): Conflict[] {
    return this.sql(`SELECT c.*, json_extract(o.lead_json,'$.company') company FROM crm_conflicts c LEFT JOIN crm_outbox o ON o.crm=c.crm AND o.lead_id=c.lead_id
      WHERE c.crm=? AND c.status='open' ORDER BY c.created_at`).all(this.crm) as any;
  }
  closeConflict(id: string, status: "approved" | "rejected") { this.sql(`UPDATE crm_conflicts SET status=?, decided_at=? WHERE id=? AND status='open'`).run(status, Date.now(), id); }
}
