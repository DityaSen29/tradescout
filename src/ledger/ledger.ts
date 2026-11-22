import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Evidence, ProposedAction, TradeRequest } from "../core/types.js";
import { BudgetExceeded } from "../core/types.js";

/**
 * The run ledger. One sqlite file holds every run, every step, every call with its cost,
 * every piece of evidence and every action. A killed process resumes from here, and an
 * action with the same idempotency key can only execute once.
 */
export interface RunRow {
  id: string; request: TradeRequest; status: "running" | "done" | "failed" | "budget_exceeded";
  created_at: string; updated_at: string; time_limit_ms: number; credit_limit: number;
}
export interface CallMeta {
  run_id: string; step: string; source: string; endpoint: string; request_hash?: string;
}
export interface CallRow extends CallMeta {
  id: string; status: "ok" | "error" | "cached"; credits: number; model_cost_usd: number; latency_ms: number;
  retrieved_at: string; response_json: string | null; note: string | null;
}

export const now = () => new Date().toISOString();
export const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

export class Ledger {
  readonly db: DatabaseSync;
  constructor(path = process.env.TRADESCOUT_DB ?? "data/tradescout.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, time_limit_ms INTEGER NOT NULL, credit_limit REAL NOT NULL, clock_started_at TEXT);
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, output_json TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, name));
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step TEXT NOT NULL, source TEXT NOT NULL, endpoint TEXT NOT NULL,
        request_hash TEXT, status TEXT NOT NULL, credits REAL NOT NULL DEFAULT 0, model_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0, retrieved_at TEXT NOT NULL, response_json TEXT, note TEXT);
      CREATE INDEX IF NOT EXISTS calls_run_hash ON calls(run_id, request_hash);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step TEXT NOT NULL, subject TEXT, claim TEXT NOT NULL, source_type TEXT NOT NULL,
        source_url TEXT NOT NULL, record_id TEXT, field TEXT, record_date TEXT, retrieved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, executed_at TEXT, result_json TEXT);
      CREATE TABLE IF NOT EXISTS snapshots (
        run_id TEXT NOT NULL, request_hash TEXT NOT NULL, taken_at TEXT NOT NULL, report_json TEXT NOT NULL);
    `);
    try { this.db.exec(`ALTER TABLE runs ADD COLUMN clock_started_at TEXT`); } catch { /* column exists */ }
  }

  // ---- runs -------------------------------------------------------------
  createRun(request: TradeRequest, limits?: { time_limit_ms?: number; credit_limit?: number }): string {
    const id = randomUUID();
    const t = now();
    this.db.prepare(`INSERT INTO runs (id, request_json, status, created_at, updated_at, time_limit_ms, credit_limit, clock_started_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      id, JSON.stringify(request), "running", t, t,
      limits?.time_limit_ms ?? Number(process.env.RUN_TIME_LIMIT_MS ?? 240000),
      limits?.credit_limit ?? Number(process.env.RUN_CREDIT_LIMIT ?? 60), t);
    return id;
  }
  getRun(id: string): RunRow | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as any;
    return r ? { ...r, request: JSON.parse(r.request_json) } : null;
  }
  /** Status change. Entering "running" restarts the time ceiling's clock: the limit is active run time per attempt, not wall time across a kill. */
  setRunStatus(id: string, status: RunRow["status"]) {
    if (status === "running") this.db.prepare(`UPDATE runs SET status = ?, updated_at = ?, clock_started_at = ? WHERE id = ?`).run(status, now(), now(), id);
    else this.db.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), id);
  }
  listRuns(limit = 50): RunRow[] {
    return (this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as any[])
      .map(r => ({ ...r, request: JSON.parse(r.request_json) }));
  }

  // ---- steps (checkpoints) ---------------------------------------------
  stepOutput<T = unknown>(runId: string, name: string): { status: string; output: T | null; attempts: number } | null {
    const r = this.db.prepare(`SELECT status, output_json, attempts FROM steps WHERE run_id = ? AND name = ?`).get(runId, name) as any;
    return r ? { status: r.status, output: r.output_json ? JSON.parse(r.output_json) : null, attempts: r.attempts } : null;
  }
  startStep(runId: string, name: string) {
    this.db.prepare(`INSERT INTO steps (run_id, name, status, started_at, attempts) VALUES (?,?,?,?,1)
      ON CONFLICT(run_id, name) DO UPDATE SET status='running', started_at=excluded.started_at, error=NULL, attempts=attempts+1`)
      .run(runId, name, "running", now());
  }
  finishStep(runId: string, name: string, output: unknown) {
    this.db.prepare(`UPDATE steps SET status='done', finished_at=?, output_json=? WHERE run_id=? AND name=?`)
      .run(now(), JSON.stringify(output ?? null), runId, name);
  }
  failStep(runId: string, name: string, error: string) {
    this.db.prepare(`UPDATE steps SET status='failed', finished_at=?, error=? WHERE run_id=? AND name=?`).run(now(), error, runId, name);
  }
  /** Forget checkpoints from `name` onward so they re-run; memoised calls stay, so nothing is paid twice. */
  resetStepsFrom(runId: string, name: string, order: string[]) {
    const idx = order.indexOf(name); if (idx < 0) throw new Error(`unknown step ${name}`);
    for (const n of order.slice(idx)) this.db.prepare(`DELETE FROM steps WHERE run_id=? AND name=?`).run(runId, n);
    this.db.prepare(`DELETE FROM actions WHERE run_id=? AND status='proposed'`).run(runId); // un-decided proposals are re-derived; decided ones stay
    this.setRunStatus(runId, "running");
  }
  listSteps(runId: string) {
    return this.db.prepare(`SELECT name, status, started_at, finished_at, attempts, error FROM steps WHERE run_id=? ORDER BY started_at`).all(runId) as any[];
  }

  // ---- calls (the cost ledger) ------------------------------------------
  findCall(runId: string, requestHash: string): CallRow | null {
    return (this.db.prepare(`SELECT * FROM calls WHERE run_id=? AND request_hash=? AND status IN ('ok','cached') AND response_json IS NOT NULL ORDER BY retrieved_at DESC LIMIT 1`)
      .get(runId, requestHash) as CallRow | undefined) ?? null;
  }
  recordCall(c: Omit<CallRow, "id" | "retrieved_at"> & { retrieved_at?: string }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, c.run_id, c.step, c.source, c.endpoint, c.request_hash ?? null, c.status, c.credits, c.model_cost_usd,
      c.latency_ms, c.retrieved_at ?? now(), c.response_json, c.note ?? null);
    return id;
  }
  listCalls(runId: string) {
    return this.db.prepare(`SELECT id, step, source, endpoint, status, credits, model_cost_usd, latency_ms, retrieved_at, note FROM calls WHERE run_id=? ORDER BY retrieved_at`).all(runId) as any[];
  }
  totals(runId: string): { credits_used: number; model_cost_usd: number; calls: number } {
    const r = this.db.prepare(`SELECT COALESCE(SUM(credits),0) c, COALESCE(SUM(model_cost_usd),0) m, COUNT(*) n FROM calls WHERE run_id=?`).get(runId) as any;
    return { credits_used: Number(r.c), model_cost_usd: Number(r.m), calls: Number(r.n) };
  }
  /** Throws BudgetExceeded when the run is over its time or credit ceiling. Call before every paid call. */
  assertBudget(runId: string) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    const elapsed = Date.now() - Date.parse((run as any).clock_started_at ?? run.created_at);
    if (elapsed > run.time_limit_ms) throw new BudgetExceeded("time", `run ${runId} exceeded ${run.time_limit_ms} ms`);
    const t = this.totals(runId);
    if (t.credits_used > run.credit_limit) throw new BudgetExceeded("credits", `run ${runId} used ${t.credits_used} of ${run.credit_limit} credits`);
  }

  // ---- evidence -----------------------------------------------------------
  addEvidence(runId: string, step: string, subject: string | null, e: Evidence): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO evidence VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, runId, step, subject, e.claim, e.source_type, e.source_url, e.record_id ?? null, e.field ?? null, e.record_date, e.retrieved_at);
    return id;
  }
  listEvidence(runId: string) {
    return this.db.prepare(`SELECT * FROM evidence WHERE run_id=? ORDER BY retrieved_at`).all(runId) as any[];
  }

  // ---- actions: proposed → approved → executed, exactly once -------------
  proposeAction(runId: string, kind: ProposedAction["kind"], idempotencyKey: string, payload: Record<string, unknown>): ProposedAction {
    const existing = this.getActionByKey(idempotencyKey);
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO actions (id, run_id, kind, idempotency_key, status, payload_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, runId, kind, idempotencyKey, "proposed", JSON.stringify(payload), now());
    return this.getAction(id)!;
  }
  getAction(id: string): ProposedAction | null {
    const r = this.db.prepare(`SELECT * FROM actions WHERE id=?`).get(id) as any;
    return r ? this.rowToAction(r) : null;
  }
  getActionByKey(key: string): ProposedAction | null {
    const r = this.db.prepare(`SELECT * FROM actions WHERE idempotency_key=?`).get(key) as any;
    return r ? this.rowToAction(r) : null;
  }
  listActions(runId: string): ProposedAction[] {
    return (this.db.prepare(`SELECT * FROM actions WHERE run_id=? ORDER BY created_at`).all(runId) as any[]).map(r => this.rowToAction(r));
  }
  decideAction(id: string, decision: "approved" | "rejected", who = "person") {
    const res = this.db.prepare(`UPDATE actions SET status=? WHERE id=? AND status='proposed'`).run(decision, id);
    if (res.changes === 0) throw new Error(`action ${id} is not awaiting a decision`);
    this.db.prepare(`UPDATE actions SET result_json=? WHERE id=?`).run(JSON.stringify({ decided_by: who, at: now() }), id);
  }
  /**
   * Execute an approved action exactly once. The state transition approved→executing is a single
   * UPDATE guarded by the current status, so two processes racing after a restart cannot both run `fn`.
   */
  async executeAction<T>(id: string, fn: (a: ProposedAction) => Promise<T>): Promise<{ ran: boolean; result: T | null }> {
    const claimed = this.db.prepare(`UPDATE actions SET status='executing' WHERE id=? AND status='approved'`).run(id);
    if (claimed.changes === 0) return { ran: false, result: null };
    const a = this.getAction(id)!;
    try {
      const result = await fn(a);
      this.db.prepare(`UPDATE actions SET status='executed', executed_at=?, result_json=? WHERE id=?`).run(now(), JSON.stringify(result ?? null), id);
      return { ran: true, result };
    } catch (err) {
      // roll back to approved so a retry can execute it; nothing external happened if fn is written to act last
      this.db.prepare(`UPDATE actions SET status='approved' WHERE id=?`).run(id);
      throw err;
    }
  }
  private rowToAction(r: any): ProposedAction {
    return { id: r.id, run_id: r.run_id, kind: r.kind, idempotency_key: r.idempotency_key, status: r.status, payload: JSON.parse(r.payload_json), created_at: r.created_at, executed_at: r.executed_at };
  }

  // ---- snapshots for the monitor layer -----------------------------------
  saveSnapshot(runId: string, requestHash: string, report: unknown) {
    this.db.prepare(`INSERT INTO snapshots VALUES (?,?,?,?)`).run(runId, requestHash, now(), JSON.stringify(report));
  }
  previousSnapshot(requestHash: string, beforeRunId: string): { run_id: string; taken_at: string; report: any } | null {
    const r = this.db.prepare(`SELECT run_id, taken_at, report_json FROM snapshots WHERE request_hash=? AND run_id<>? ORDER BY taken_at DESC LIMIT 1`).get(requestHash, beforeRunId) as any;
    return r ? { run_id: r.run_id, taken_at: r.taken_at, report: JSON.parse(r.report_json) } : null;
  }
}
