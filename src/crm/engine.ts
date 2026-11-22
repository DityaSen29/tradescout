import { randomUUID } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import type { Lead } from "../buyer/contract.js";
import { BudgetExceeded } from "../core/types.js";
import { CrmError, KINDS, NotConnected, type AdapterFactory, type CrmAdapter, type CrmRecord, type Kind, type Meter, type Props } from "./adapter.js";
import { mapLead, minimise, type Mapped, type SyncLead } from "./mapping.js";
import { Store, type Conflict, type Job, type Link } from "./store.js";

type Outcome = "created" | "updated" | "skipped" | "review";
export interface SyncResult {
  created: number; updated: number; skipped: number; errors: number;
  details: { lead_id: string; outcome: Outcome | "error"; message?: string }[];
}
export interface PullResult { applied: number; conflicts: number; error: string | null }

const MAX_ATTEMPTS = 6;
const POLL = "crm-poll";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const text = (e: any) => String(e?.message ?? e).replace(/[^\s"'<>:]+@[^\s"'<>]+/g, "[email]").slice(0, 300);

/**
 * Two-way sync for one CRM.
 * Out: outbox, then look up by our external id, then create or patch only the fields we own.
 * In: polling or webhooks, each change applied once, only for fields the CRM owns.
 * Deletes, merges and lookalike records wait for a person.
 */
export class CrmSync {
  readonly store: Store;
  readonly adapter: CrmAdapter;
  private owner = "";
  private runId = POLL;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private ledger: Ledger, factory: AdapterFactory) {
    const meter: Meter = async (endpoint, fn) => {
      if (!this.owner || !this.store.tryLock(this.owner)) throw new CrmError(423, "lost the CRM worker lock");
      this.store.reserveCall(this.runId);
      const t0 = Date.now();
      // no request hash and no body: a sync call must never be replayed from the memo, and bodies hold personal data
      const record = (status: "ok" | "error", note: string | null) => this.ledger.recordCall({ run_id: this.runId, step: "crm", source: this.adapter.name, endpoint, status, credits: 0, model_cost_usd: 0, latency_ms: Date.now() - t0, response_json: null, note });
      try { const out = await fn(); record("ok", null); return out; }
      catch (e) { record("error", text(e)); throw e; }
    };
    this.adapter = factory(meter);
    this.store = new Store(ledger, this.adapter.name);
  }

  /** One operation at a time here (the queue) and across processes (the lock). */
  private exclusive<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      const owner = randomUUID(), until = Date.now() + 20_000;
      while (!this.store.tryLock(owner)) {
        if (Date.now() > until) throw new Error("CRM sync is busy in another process; queued work is kept");
        await sleep(250);
      }
      this.owner = owner; this.runId = runId;
      try { return await fn(); } finally { this.store.unlock(owner); this.owner = ""; }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  private async prepare() {
    try {
      const { account } = await this.adapter.connect();
      const known = this.store.meta("account");
      // the links hold that account's record ids, so another account must not reuse them
      if (known && known !== account) throw new NotConnected(`this ledger is linked to CRM account ${known}, not ${account}; use a separate database`);
      this.store.setMeta("account", account);
      if (!this.store.meta("schema")) { await this.adapter.ensureSchema(); this.store.setMeta("schema", "ready"); }
      this.store.setMeta("connected_at", String(Date.now()));
      this.store.setMeta("error", "");
    } catch (e) { this.store.setMeta("connected_at", ""); this.store.setMeta("error", text(e)); throw e; }
  }

  async connect(): Promise<string | null> {
    try { await this.exclusive(POLL, () => this.prepare()); return null; } catch (e) { return text(e); }
  }

  // ---- out -----------------------------------------------------------------
  async push(runId: string, leads: Lead[]): Promise<SyncResult> {
    const details = new Map<string, SyncResult["details"][number]>();
    let i = 0;
    for (const lead of Array.isArray(leads) ? leads : []) {
      const id = String(lead?.lead_id ?? `item ${i}`); i++;
      if (lead?.selected !== true) { if (!details.has(id)) details.set(id, { lead_id: id, outcome: "skipped", message: "not selected" }); continue; }
      try {
        this.store.enqueue(runId, minimise(lead, this.outreachStatus(id)));
        details.set(id, { lead_id: id, outcome: "error", message: "queued, not written yet" });
      } catch (e) { details.set(id, { lead_id: id, outcome: "error", message: text(e) }); }
    }
    try {
      for (const d of await this.drain(runId)) if (details.has(d.lead_id)) details.set(d.lead_id, d);
    } catch (e) {
      for (const d of details.values()) if (d.outcome === "error") d.message = text(e);
    }
    const list = [...details.values()], count = (o: string) => list.filter(d => d.outcome === o).length;
    return { created: count("created"), updated: count("updated"), skipped: count("skipped") + count("review"), errors: count("error"), details: list };
  }

  private outreachStatus(leadId: string): string {
    const rows = this.ledger.db.prepare(`SELECT status FROM actions WHERE kind='email_draft' AND json_extract(payload_json,'$.lead_id')=?`).all(leadId) as { status: string }[];
    const order = ["rejected", "proposed", "approved", "executing", "unknown", "executed"];
    const best = rows.map(r => r.status).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    return best ? `draft ${best}` : "selected";
  }

  drain(runId = POLL): Promise<SyncResult["details"]> {
    return this.exclusive(runId, async () => {
      const done: SyncResult["details"] = [];
      this.store.recoverInFlight();
      await this.prepare();
      let initial: Props | undefined;
      const initialDeal = async () => (initial ??= await this.adapter.initialDeal());
      for (let n = this.store.outbox().length * 2; n > 0; n--) {
        const job = this.store.claim();
        if (!job) break;
        try {
          const outcome = await this.writeLead(job.lead, initialDeal);
          this.store.settle(job, outcome === "review" ? "review" : "done");
          done.push({ lead_id: job.lead_id, outcome });
          this.store.setMeta("last_push", String(Date.now()));
        } catch (e) {
          const stop = e instanceof BudgetExceeded || e instanceof NotConnected;
          if (stop) this.store.settle(job, "pending", text(e));
          else this.failed(job, e);
          done.push({ lead_id: job.lead_id, outcome: "error", message: text(e) });
          if (stop) { this.store.setMeta("error", text(e)); break; }
        }
      }
      return done;
    });
  }

  private failed(job: Job, e: unknown) {
    const retry = e instanceof CrmError && e.retryable && job.attempts + 1 < MAX_ATTEMPTS;
    const wait = Math.max((e as CrmError)?.retryAfterMs ?? 0, Math.min(300_000, 2000 * 2 ** job.attempts) + Math.random() * 500);
    this.store.settle(job, retry ? "retry" : "failed", text(e), retry ? Math.round(Date.now() + wait) : 0);
  }

  private async writeLead(lead: SyncLead, initialDeal: () => Promise<Props>): Promise<Outcome> {
    const mapped = mapLead(lead, this.adapter.ours), ids: Partial<Record<Kind, string>> = {}, seen = new Set<Outcome>();
    for (const kind of KINDS) {
      const want = mapped[kind];
      if (!want) continue;
      const r = await this.writeRecord(lead.lead_id, kind, want, initialDeal);
      seen.add(r.outcome);
      if (r.id) ids[kind] = r.id;
    }
    for (const [from, to] of [["contact", "company"], ["deal", "company"], ["deal", "contact"]] as const) {
      const a = ids[from], b = ids[to];
      if (!a || !b || this.store.isAssociated(`${from}:${a}`, `${to}:${b}`)) continue;
      await this.adapter.link(from, a, to, b);
      this.store.associated(`${from}:${a}`, `${to}:${b}`);
    }
    return (["review", "created", "updated"] as const).find(o => seen.has(o)) ?? "skipped";
  }

  private async writeRecord(leadId: string, kind: Kind, want: Mapped, initialDeal: () => Promise<Props>): Promise<{ outcome: Outcome; id?: string }> {
    const { store, adapter } = this;
    const review = { outcome: "review" as const };
    if (store.awaitingPerson(leadId, kind)) return review;
    let link = store.link(leadId, kind);
    if (link?.state === "paused") return { outcome: "skipped" };

    let record: CrmRecord | null;
    if (link) {
      record = await adapter.get(kind, link.remote_id);
      if (!record) { store.openConflict({ type: "delete", lead_id: leadId, kind, remote_id: link.remote_id }); return review; }
      if (record.id !== link.remote_id) { store.openConflict({ type: "merge", lead_id: leadId, kind, remote_id: link.remote_id, theirs: record.id }); return review; }
    } else {
      // also finds what a crash created before it could save the link
      record = await adapter.findByExternalId(kind, leadId);
      if (!record) {
        const sibling = store.linkByNatural(kind, want.natural);
        if (sibling) {
          // a second lead at a company or person we already wrote: share it, and leave its fields to the first lead
          store.saveLink({ lead_id: leadId, kind, remote_id: sibling.remote_id, natural: want.natural, state: "active", pushed: {}, held: [...adapter.ours[kind]] });
          return { outcome: "skipped", id: sibling.remote_id };
        }
        const same = (await adapter.findByNaturalKey(kind, want.natural))[0];
        if (same) {
          store.openConflict({ type: "duplicate", lead_id: leadId, kind, remote_id: same.id, ours: want.natural, theirs: Object.values(this.pick(same, kind)).join(" / ") });
          return review;
        }
        const extra = kind === "deal" ? await initialDeal() : {};
        let made: CrmRecord;
        try { made = await adapter.create(kind, { ...extra, ...want.props, [adapter.idField]: leadId }); }
        catch (e) {
          // 409: the record exists and search has not indexed it yet, so look again on a retry
          if (e instanceof CrmError && e.status === 409) throw new CrmError(423, e.message);
          throw e;
        }
        const pushed = { ...want.props };
        for (const k of Object.keys(pushed)) if (made.props[k]) pushed[k] = made.props[k];
        store.saveLink({ lead_id: leadId, kind, remote_id: made.id, natural: want.natural, state: "active", pushed, held: [] });
        return { outcome: "created", id: made.id };
      }
      link = { lead_id: leadId, kind, remote_id: record.id, natural: want.natural, state: "active", pushed: this.pick(record, kind), held: [] };
    }

    // a new decision-maker must not silently overwrite the person, and the history, already on that record
    if (kind === "contact" && link.natural && want.natural && link.natural !== want.natural && adapter.ours.contact.some(f => !link!.held.includes(f))) {
      store.openConflict({ type: "person", lead_id: leadId, kind, remote_id: record.id, ours: want.natural, theirs: link.natural });
      return review;
    }
    const patch: Props = {}, pushed = { ...link.pushed };
    let conflicted = false;
    for (const [field, value] of Object.entries(want.props)) {
      if (link.held.includes(field)) continue;
      const current = record.props[field] ?? "", last = link.pushed[field] ?? "";
      if (current === value || current === last) store.clearField(leadId, kind, field);
      if (current === value) { pushed[field] = value; continue; }
      if (current !== last) {
        store.openConflict({ type: "field", lead_id: leadId, kind, field, remote_id: record.id, ours: value, theirs: current });
        conflicted = true;
      } else patch[field] = value;
    }
    if (!record.props[adapter.idField]) patch[adapter.idField] = leadId;
    const changed = Object.keys(patch).length > 0;
    if (changed) {
      const after = await adapter.update(kind, record.id, patch);
      for (const [k, v] of Object.entries(patch)) if (k !== adapter.idField) pushed[k] = after.props[k] || v;
    }
    store.saveLink({ ...link, natural: want.natural || link.natural, pushed });
    return { outcome: conflicted ? "review" : changed ? "updated" : "skipped", id: record.id };
  }
  private pick(r: CrmRecord, kind: Kind): Props {
    return Object.fromEntries(this.adapter.ours[kind].filter(f => r.props[f]).map(f => [f, r.props[f]]));
  }

  // ---- in ------------------------------------------------------------------
  async pull(): Promise<PullResult> {
    const before = new Set(this.store.openConflicts().map(c => c.id));
    let applied = 0, error: string | null = null;
    try {
      await this.exclusive(POLL, async () => {
        await this.prepare();
        for (const kind of KINDS) applied += await this.pullKind(kind);
        this.store.setMeta("last_pull", String(Date.now()));
      });
    } catch (e) { error = text(e); this.store.setMeta("error", error); }
    return { applied, conflicts: this.store.openConflicts().filter(c => !before.has(c.id)).length, error };
  }

  private async pullKind(kind: Kind): Promise<number> {
    const { store, adapter } = this;
    const links = store.links(kind).filter(l => l.state === "active");
    if (!links.length) return 0;
    const records = new Map((await adapter.read(kind, [...new Set(links.map(l => l.remote_id))])).map(r => [r.id, r]));
    let applied = 0;
    for (const r of records.values()) {
      if (!links.some(l => l.remote_id === r.id)) continue;
      for (const c of [...r.changes].sort((a, b) => a.at - b.at))
        if (adapter.theirs[kind].includes(c.field) && store.applyEvent(kind, r.id, c.field, c.value, c.at)) applied++;
    }
    for (const link of links) {
      const record = records.get(link.remote_id);
      if (record) { this.checkDrift(link, record); continue; }
      if (store.awaitingPerson(link.lead_id, kind)) continue;
      // missing from the batch: ask by id, which answers with the survivor of a merge
      const now = await adapter.get(kind, link.remote_id);
      if (!now) store.openConflict({ type: "delete", lead_id: link.lead_id, kind, remote_id: link.remote_id });
      else if (now.id !== link.remote_id) store.openConflict({ type: "merge", lead_id: link.lead_id, kind, remote_id: link.remote_id, theirs: now.id });
    }
    return applied;
  }
  private checkDrift(link: Link, r: CrmRecord) {
    const lead = this.store.desired(link.lead_id);
    const want = lead ? mapLead(lead, this.adapter.ours)[link.kind]?.props : undefined;
    for (const [field, last] of Object.entries(link.pushed)) {
      if (link.held.includes(field)) continue;
      const current = r.props[field] ?? "", ours = want?.[field] ?? last;
      if (current === last || current === ours) this.store.clearField(link.lead_id, link.kind, field);
      else this.store.openConflict({ type: "field", lead_id: link.lead_id, kind: link.kind, field, remote_id: r.id, ours, theirs: current });
    }
  }

  /** Verified HubSpot webhook events. They land in the same event log as polling. */
  ingest(events: unknown): { applied: number; review: number } {
    if (!Array.isArray(events)) throw new Error("expected a list of events");
    let applied = 0, review = 0;
    for (const e of events as any[]) {
      const [name, what] = String(e?.subscriptionType ?? "").split(".");
      const kind = KINDS.find(k => k === name);
      if (!kind) continue;
      const id = String(e.objectId ?? ""), at = Number(e.occurredAt);
      if (what === "propertyChange" && Number.isFinite(at) && this.adapter.theirs[kind].includes(e.propertyName)) {
        if (this.store.links(kind, id).length && this.store.applyEvent(kind, id, e.propertyName, String(e.propertyValue ?? ""), at)) applied++;
      } else if (what === "deletion" || what === "privacyDeletion") {
        for (const l of this.store.links(kind, id)) if (l.state === "active") { this.store.openConflict({ type: "delete", lead_id: l.lead_id, kind, remote_id: id }); review++; }
      } else if (what === "merge") {
        const survivor = String(e.newObjectId ?? e.primaryObjectId ?? "");
        if (!survivor) continue;
        for (const old of new Set([e.primaryObjectId, ...(Array.isArray(e.mergedObjectIds) ? e.mergedObjectIds : [])].filter(Boolean).map(String)))
          if (old !== survivor) for (const l of this.store.links(kind, old)) if (l.state === "active") { this.store.openConflict({ type: "merge", lead_id: l.lead_id, kind, remote_id: old, theirs: survivor }); review++; }
      }
    }
    return { applied, review };
  }

  // ---- a person decides ----------------------------------------------------
  /**
   * field: approve keeps our value, reject keeps the CRM's from now on.
   * duplicate: approve links the existing record, reject leaves it unsynced.
   * person: approve replaces the contact's details, reject keeps the first person.
   * delete: approve accepts it, reject recreates the record.
   * merge: approve follows the survivor, reject stops syncing the record.
   */
  decide(id: string, decision: "approved" | "rejected"): Promise<void> {
    return this.exclusive(POLL, async () => {
      const c: Conflict | undefined = this.store.conflict(id);
      if (c?.status !== "open") throw new Error("this item changed or was already decided; refresh and look again");
      const { store } = this, yes = decision === "approved", all = [...this.adapter.ours[c.kind]];
      store.atomic(() => {
        const link: Link = store.link(c.lead_id, c.kind) ?? { lead_id: c.lead_id, kind: c.kind, remote_id: c.remote_id, natural: "", state: "active", pushed: {}, held: [] };
        if (c.type === "field") {
          if (yes) link.pushed[c.field] = c.theirs;
          else link.held = [...new Set([...link.held, c.field])];
        } else if (c.type === "duplicate") {
          // linking a record someone else made never licenses overwriting it
          Object.assign(link, { remote_id: c.remote_id, state: yes ? "active" : "paused", held: all, natural: yes ? c.ours : "" });
        } else if (c.type === "person") {
          if (yes) link.natural = c.ours;
          else link.held = all;
        } else if (c.type === "merge") {
          Object.assign(link, yes ? { remote_id: c.theirs, pushed: {}, held: all } : { state: "paused" });
        } else if (yes) link.state = "paused";
        if (c.type === "delete" && !yes) store.dropLink(c.lead_id, c.kind);
        else store.saveLink(link);
        store.closeConflict(id, decision);
        store.requeue(c.lead_id);
      });
    });
  }

  status() {
    const { store } = this, num = (k: string) => Number(store.meta(k)) || null;
    const leads = store.outbox();
    return {
      crm: this.adapter.name,
      account: store.meta("account") || null,
      connected: !!store.meta("connected_at") && !store.meta("error"),
      error: store.meta("error") || null,
      last_push: num("last_push"), last_pull: num("last_pull"),
      calls_today: store.callsToday(),
      leads: leads.map(l => {
        const deal = store.link(l.lead_id, "deal");
        return { ...l, crm_owned: deal ? store.values("deal", deal.remote_id) : {} };
      }),
      conflicts: store.openConflicts(),
    };
  }
  crmOwned(leadId: string): Props {
    const deal = this.store.link(leadId, "deal");
    return deal ? this.store.values("deal", deal.remote_id) : {};
  }
}
