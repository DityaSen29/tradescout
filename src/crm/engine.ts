import { randomUUID } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import type { Lead } from "../buyer/contract.js";
import { BudgetExceeded } from "../core/types.js";
import { CrmError, KINDS, NotConnected, scrub, type AdapterFactory, type AdapterState, type CrmAdapter, type CrmRecord, type Kind, type Meter, type Props } from "./adapter.js";
import { mapLead, minimise, type Mapped, type SyncLead } from "./mapping.js";
import { Store, type Conflict, type Job, type Link } from "./store.js";

type Outcome = "created" | "updated" | "skipped" | "review";
export interface SyncResult {
  created: number; updated: number; skipped: number; errors: number;
  details: { lead_id: string; outcome: Outcome | "error"; message?: string }[];
}
export interface PullResult { applied: number; conflicts: number; error: string | null }

const MAX_ATTEMPTS = 6;
/** Leads written at the same time. The adapters turn their calls into batch requests. */
const WAVE = 50;
/** This many records all missing at once is an outage or lost permission, not that many deletes. */
const MASS_MISSING = 5;
const POLL = "crm-poll";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isName = (natural: string) => natural.startsWith("name:");
const personShown = (c: NonNullable<SyncLead["contact"]>) => [`${c.first} ${c.last}`.trim(), c.email].filter(Boolean).join(", ");

/**
 * Two-way sync for one CRM connection.
 * Out: outbox, then look up by our external id, then create or patch only the fields we own.
 * In: polling or webhooks, each change applied once, only for fields the CRM owns.
 * Deletes, merges, lookalike records and changes of person wait for a person.
 */
export class CrmSync {
  readonly store: Store;
  readonly adapter: CrmAdapter;
  private owner = "";
  private runId = POLL;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private ledger: Ledger, factory: AdapterFactory, key?: string) {
    const meter: Meter = async (endpoint, fn, units = 1) => {
      if (!this.owner || !this.store.tryLock(this.owner)) throw new CrmError(423, "lost the CRM worker lock");
      this.store.reserveCall(this.runId, units);
      const t0 = Date.now();
      // no request hash and no body: a sync call must never be replayed from the memo, and bodies hold personal data
      const record = (status: "ok" | "error", note: string | null) => this.ledger.recordCall({ run_id: this.runId, step: "crm", source: this.adapter.name, endpoint, status, credits: 0, model_cost_usd: 0, latency_ms: Date.now() - t0, response_json: null, note });
      try { const out = await fn(); record("ok", null); return out; }
      catch (e) { record("error", scrub(e)); throw e; }
    };
    const state: AdapterState = { get: k => this.store.meta(`adapter:${k}`), set: (k, v) => this.store.setMeta(`adapter:${k}`, v) };
    this.adapter = factory(meter, state);
    this.store = new Store(ledger, key ?? this.adapter.name, this.adapter.name, this.adapter.limits);
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
      this.adapter.begin?.();
      try { return await fn(); } finally { this.store.unlock(owner); this.owner = ""; }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  private async prepare() {
    const { store, adapter } = this;
    try {
      const { account } = await adapter.connect();
      const known = store.meta("account");
      // the links hold that account's record ids, so another account must not reuse them
      if (known && known !== account) throw new NotConnected(`this connection is linked to CRM account ${known}, not ${account}; add the other account as its own connection`);
      if (!known && store.crm.includes("@")) {
        const other = store.sharedWith(adapter.name, account);
        if (other) throw new NotConnected(`that CRM account already belongs to ${other}; two clients cannot share one`);
      }
      store.setMeta("account", account);
      store.setMeta("provider", adapter.name);
      if (!store.meta("schema")) { await adapter.ensureSchema(); store.setMeta("schema", "ready"); }
      store.setMeta("connected_at", String(Date.now()));
      store.setMeta("error", "");
    } catch (e) { store.setMeta("connected_at", ""); store.setMeta("error", scrub(e)); throw e; }
  }

  async connect(): Promise<string | null> {
    try { await this.exclusive(POLL, () => this.prepare()); return null; } catch (e) { return scrub(e); }
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
      } catch (e) { details.set(id, { lead_id: id, outcome: "error", message: scrub(e) }); }
    }
    try {
      for (const d of await this.drain(runId)) if (details.has(d.lead_id)) details.set(d.lead_id, d);
    } catch (e) {
      for (const d of details.values()) if (d.outcome === "error") d.message = scrub(e);
    }
    return tally([...details.values()]);
  }

  private outreachStatus(leadId: string): string {
    const rows = this.ledger.db.prepare(`SELECT status FROM actions WHERE kind='email_draft' AND json_extract(payload_json,'$.lead_id')=?`).all(leadId) as { status: string }[];
    const order = ["rejected", "proposed", "approved", "executing", "unknown", "executed"];
    const best = rows.map(r => r.status).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    return best ? `draft ${best}` : "selected";
  }
  /** A draft approved after the push still reaches the CRM: the outreach status is a field we own. */
  refreshStatuses(): number {
    let changed = 0;
    for (const { run_id, lead } of this.store.settled()) {
      const status = this.outreachStatus(lead.lead_id);
      if (status === lead.status) continue;
      this.store.enqueue(run_id, { ...lead, status });
      changed++;
    }
    return changed;
  }

  private mapped(lead: SyncLead): Record<Kind, Mapped | null> {
    const out = mapLead(lead, this.adapter.ours);
    if (this.adapter.normalise)
      for (const kind of KINDS) { const m = out[kind]; if (m) m.props = this.adapter.normalise(kind, m.props); }
    return out;
  }

  drain(runId = POLL): Promise<SyncResult["details"]> {
    return this.exclusive(runId, async () => {
      const done: SyncResult["details"] = [], { store } = this;
      store.recoverInFlight();
      await this.prepare();
      let initial: Promise<Props> | undefined;
      const initialDeal = () => (initial ??= this.adapter.initialDeal());
      let left = store.outbox().length * 2, stop: unknown = null;

      while (left > 0 && !stop) {
        const jobs: Job[] = [];
        for (let job; jobs.length < WAVE && (job = store.claim()); ) jobs.push(job);
        if (!jobs.length) break;
        left -= jobs.length;
        for (const wave of this.waves(jobs)) {
          if (stop) { for (const job of wave) store.settle(job, "pending", scrub(stop)); continue; }
          await Promise.all(wave.map(async job => {
            try {
              const outcome = await this.writeLead(job.lead, initialDeal);
              store.settle(job, outcome === "review" ? "review" : "done");
              done.push({ lead_id: job.lead_id, outcome });
              store.setMeta("last_push", String(Date.now()));
            } catch (e) {
              if (e instanceof BudgetExceeded || e instanceof NotConnected) { stop ??= e; store.settle(job, "pending", scrub(e)); }
              else this.failed(job, e);
              done.push({ lead_id: job.lead_id, outcome: "error", message: scrub(e) });
            }
          }));
        }
      }
      if (stop) store.setMeta("error", scrub(stop));
      return done;
    });
  }
  /** Two leads at one company or person never run in the same wave, so the second finds the first's record. */
  private waves(jobs: Job[]): Job[][] {
    const waves: { jobs: Job[]; keys: Set<string> }[] = [];
    for (const job of jobs) {
      const m = mapLead(job.lead, this.adapter.ours);
      const keys = KINDS.flatMap(k => (m[k]?.natural ? [`${k}:${m[k]!.natural}`] : []));
      let w = waves.find(x => !keys.some(k => x.keys.has(k)));
      if (!w) waves.push((w = { jobs: [], keys: new Set() }));
      w.jobs.push(job);
      for (const k of keys) w.keys.add(k);
    }
    return waves.map(w => w.jobs);
  }

  private failed(job: Job, e: unknown) {
    const retry = e instanceof CrmError && e.retryable && (e.throttled || job.attempts + 1 < MAX_ATTEMPTS);
    const wait = Math.max((e as CrmError)?.retryAfterMs ?? 0, Math.min(300_000, 2000 * 2 ** Math.min(job.attempts, 8)) + Math.random() * 500);
    this.store.settle(job, retry ? "retry" : "failed", scrub(e), retry ? Math.round(Date.now() + wait) : 0);
  }

  private async writeLead(lead: SyncLead, initialDeal: () => Promise<Props>): Promise<Outcome> {
    const mapped = this.mapped(lead), ids: Partial<Record<Kind, string>> = {}, seen = new Set<Outcome>();
    for (const kind of KINDS) {
      const want = mapped[kind];
      if (!want) continue;
      const r = await this.writeRecord(lead, kind, want, initialDeal);
      seen.add(r.outcome);
      if (r.id) ids[kind] = r.id;
    }
    await Promise.all(([["contact", "company"], ["deal", "company"], ["deal", "contact"]] as const).map(async ([from, to]) => {
      const a = ids[from], b = ids[to];
      if (!a || !b || this.store.isAssociated(`${from}:${a}`, `${to}:${b}`)) return;
      await this.adapter.link(from, a, to, b);
      this.store.associated(`${from}:${a}`, `${to}:${b}`);
    }));
    return (["review", "created", "updated"] as const).find(o => seen.has(o)) ?? "skipped";
  }

  private async writeRecord(lead: SyncLead, kind: Kind, want: Mapped, initialDeal: () => Promise<Props>): Promise<{ outcome: Outcome; id?: string }> {
    const { store, adapter } = this, leadId = lead.lead_id;
    const review = { outcome: "review" as const };
    if (store.awaitingPerson(leadId, kind)) return review;
    let link = store.link(leadId, kind);
    if (link?.state === "paused") return { outcome: "skipped" };

    let record: CrmRecord | null;
    if (link) {
      record = await adapter.get(kind, link.remote_id);
      if (!record) { await this.gone(link); return review; }
      if (record.id !== link.remote_id) { store.openConflict({ type: "merge", lead_id: leadId, kind, remote_id: link.remote_id, theirs: record.id }); return review; }
    } else {
      // also finds what a crash created before it could save the link
      record = await adapter.findByExternalId(kind, leadId);
      if (!record) {
        const sibling = store.linkByNatural(kind, want.natural);
        if (sibling && !isName(want.natural)) {
          // a second lead at a company or person we already wrote: share it, and leave its fields to the first lead
          store.saveLink({ lead_id: leadId, kind, remote_id: sibling.remote_id, natural: want.natural, state: "active", pushed: {}, held: [...adapter.ours[kind]] });
          return { outcome: "skipped", id: sibling.remote_id };
        }
        const same = sibling ? { id: sibling.remote_id, props: sibling.pushed } : (await adapter.findByNaturalKey(kind, want.natural))[0];
        if (same) {
          // a matching name alone never shares a record without a person
          store.openConflict({ type: "duplicate", lead_id: leadId, kind, remote_id: same.id, ours: want.natural, theirs: Object.values(this.pick(same.props, kind)).join(" / ") });
          return review;
        }
        const extra = kind === "deal" ? await initialDeal() : {};
        let made: CrmRecord;
        try { made = await adapter.create(kind, { ...extra, ...want.props, [adapter.idField]: leadId }); }
        catch (e) {
          // 409: the record exists and search has not indexed it yet, so look again on a retry
          if (e instanceof CrmError && e.status === 409) throw new CrmError(503, e.message);
          throw e;
        }
        const pushed = { ...want.props };
        for (const k of Object.keys(pushed)) if (made.props[k]) pushed[k] = made.props[k];
        store.saveLink({ lead_id: leadId, kind, remote_id: made.id, natural: want.natural, state: "active", pushed, held: [] });
        if (kind === "contact" && lead.contact?.person) store.setMeta(`person:${leadId}`, lead.contact.person);
        return { outcome: "created", id: made.id };
      }
      link = { lead_id: leadId, kind, remote_id: record.id, natural: want.natural, state: "active", pushed: this.pick(record.props, kind), held: [] };
    }

    let values = want.props, replaced = false;
    if (kind === "contact" && lead.contact && adapter.ours.contact.some(f => !link!.held.includes(f))) {
      // a new decision-maker must not silently overwrite the person, and the history, already on that record
      const known = store.meta(`person:${leadId}`), person = lead.contact.person ?? "";
      const [first, last] = adapter.ours.contact;
      const sameName = [first, last].every(f => (link!.pushed[f] ?? "") === (want.props[f] ?? ""));
      const bothEmails = !!link.natural && !!want.natural, otherEmail = bothEmails && link.natural !== want.natural;
      const otherPerson = known && person
        ? known !== person || (otherEmail && !sameName)   // an id that now names someone else is someone else
        : otherEmail || (!bothEmails && !sameName && Object.keys(link.pushed).length > 0);
      if (otherPerson && store.meta(`replace:${leadId}`) !== personShown(lead.contact)) {
        const theirs = [[first, last].map(f => record!.props[f]).filter(Boolean).join(" "), link.natural].filter(Boolean).join(", ");
        store.openConflict({ type: "person", lead_id: leadId, kind, remote_id: record.id, ours: personShown(lead.contact), theirs });
        return review;
      }
      store.clearPerson(leadId);
      if (store.meta(`replace:${leadId}`)) {
        // the last person's title and email must not stay under the new person's name
        replaced = true;
        values = { ...Object.fromEntries(adapter.ours.contact.map(f => [f, ""])), ...want.props };
      }
    }

    const patch: Props = {}, pushed = { ...link.pushed };
    let conflicted = false;
    for (const [field, value] of Object.entries(values)) {
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
    const keep = !want.natural || (!!link.natural && !isName(link.natural) && isName(want.natural));
    store.saveLink({ ...link, natural: replaced ? want.natural : keep ? link.natural : want.natural, pushed });
    if (kind === "contact" && lead.contact) {
      if (lead.contact.person) store.setMeta(`person:${leadId}`, lead.contact.person);
      if (replaced && !conflicted) store.setMeta(`replace:${leadId}`, "");
    }
    return { outcome: conflicted ? "review" : changed ? "updated" : "skipped", id: record.id };
  }
  private pick(props: Props, kind: Kind): Props {
    return Object.fromEntries(this.adapter.ours[kind].filter(f => props[f]).map(f => [f, props[f]]));
  }
  private async gone(link: Link) {
    const base = { lead_id: link.lead_id, kind: link.kind, remote_id: link.remote_id };
    if (this.adapter.mergeLooksDeleted && link.natural) {
      const others = (await this.adapter.findByNaturalKey(link.kind, link.natural)).filter(r => r.id !== link.remote_id);
      if (others.length === 1) { this.store.openConflict({ ...base, type: "merge", ours: "possible", theirs: others[0].id }); return; }
    }
    this.store.openConflict({ ...base, type: "delete" });
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
        await this.housekeeping();
      });
    } catch (e) { error = scrub(e); this.store.setMeta("error", error); }
    return { applied, conflicts: this.store.openConflicts().filter(c => !before.has(c.id)).length, error };
  }
  /** Display names and notification renewal. Neither may break a pull. */
  private async housekeeping() {
    const { store, adapter } = this;
    if (adapter.renewNotifications) {
      try { await adapter.renewNotifications(); store.setMeta("notify_error", ""); }
      catch (e) { store.setMeta("notify_error", scrub(e)); }
    }
    if (adapter.labels && store.links("deal").length && Number(store.meta("labels_at")) < Date.now() - 3_600_000) {
      store.setMeta("labels_at", String(Date.now()));
      try { store.setMeta("labels", JSON.stringify(await adapter.labels())); } catch { /* the stored ids are still shown */ }
    }
  }

  private async pullKind(kind: Kind): Promise<number> {
    const { store, adapter } = this;
    const links = store.links(kind).filter(l => l.state === "active");
    if (!links.length) return 0;
    const ids = [...new Set(links.map(l => l.remote_id))], linked = new Set(ids);
    const records = new Map((await adapter.read(kind, ids, id => store.meta(`seen:${kind}:${id}`))).map(r => [r.id, r]));
    if (ids.length >= MASS_MISSING && !ids.some(id => records.has(id))) throw new CrmError(502, `all ${ids.length} ${kind} records came back missing; treating that as a CRM fault, not as deletes`);

    let applied = 0;
    for (const r of records.values()) {
      if (!linked.has(r.id)) continue;
      const theirs = adapter.theirs[kind];
      for (const c of [...r.changes].sort((a, b) => a.at - b.at))
        if (theirs.includes(c.field) && store.applyEvent(kind, r.id, c.field, c.value, c.at)) applied++;
      if (r.at) {
        // history can be cut short, so what the record says now is applied as of its last change
        const stored = store.values(kind, r.id);
        for (const f of theirs) if (f in r.props && r.props[f] !== (stored[f] ?? "") && store.applyEvent(kind, r.id, f, r.props[f], r.at)) applied++;
      }
      if (r.version) store.setMeta(`seen:${kind}:${r.id}`, r.version);
    }
    for (const link of links) {
      const record = records.get(link.remote_id);
      if (record) { this.checkDrift(link, record); continue; }
      if (store.awaitingPerson(link.lead_id, kind)) continue;
      // missing from the batch: ask by id, which answers with the survivor of a merge where the CRM does that
      const now = await adapter.get(kind, link.remote_id);
      if (!now) await this.gone(link);
      else if (now.id !== link.remote_id) store.openConflict({ type: "merge", lead_id: link.lead_id, kind, remote_id: link.remote_id, theirs: now.id });
    }
    return applied;
  }
  private checkDrift(link: Link, r: CrmRecord) {
    const lead = this.store.desired(link.lead_id);
    const want = lead ? this.mapped(lead)[link.kind]?.props : undefined;
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
    const account = this.store.meta("account");
    let applied = 0, review = 0;
    for (const e of events as any[]) {
      // record ids repeat across accounts
      if (e?.portalId !== undefined && String(e.portalId) !== account) continue;
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
      const stale = () => new Error("this item changed or was already decided; refresh and look again");
      if (c?.status !== "open") throw stale();
      const { store } = this, yes = decision === "approved", all = [...this.adapter.ours[c.kind]];
      if (c.type === "person") {
        const now = store.desired(c.lead_id)?.contact;
        if (!now || personShown(now) !== c.ours) throw stale();
      }
      store.atomic(() => {
        const link: Link = store.link(c.lead_id, c.kind) ?? { lead_id: c.lead_id, kind: c.kind, remote_id: c.remote_id, natural: "", state: "active", pushed: {}, held: [] };
        if (c.type === "field") {
          if (yes) link.pushed[c.field] = c.theirs;
          else link.held = [...new Set([...link.held, c.field])];
        } else if (c.type === "duplicate") {
          // linking a record someone else made never licenses overwriting it
          Object.assign(link, { remote_id: c.remote_id, state: yes ? "active" : "paused", held: all, natural: yes ? c.ours : "" });
        } else if (c.type === "person") {
          if (yes) store.setMeta(`replace:${c.lead_id}`, c.ours);
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
  /** Undo a stop: sync the record again if it is there (say, restored from the recycle bin), recreate it if not. */
  resume(leadId: string, kind: Kind): Promise<"linked" | "recreate"> {
    return this.exclusive(POLL, async () => {
      const link = this.store.link(leadId, kind);
      if (link?.state !== "paused") throw new Error("that record is not paused");
      await this.prepare();
      const record = await this.adapter.get(kind, link.remote_id);
      if (record) this.store.saveLink({ ...link, remote_id: record.id, state: "active" });
      else this.store.dropLink(leadId, kind);
      this.store.requeue(leadId);
      return record ? "linked" : "recreate";
    });
  }

  status() {
    const { store } = this, num = (k: string) => Number(store.meta(k)) || null;
    let labels: Record<string, Props> = {};
    try { labels = JSON.parse(store.meta("labels") || "{}"); } catch { /* show stored values */ }
    const [stage, , owner, amount] = this.adapter.name === "zoho" ? ["Stage", "Pipeline", "Owner", "Amount"] : ["dealstage", "pipeline", "hubspot_owner_id", "amount"];
    return {
      crm: this.adapter.name,
      connection: store.crm,
      account: store.meta("account") || null,
      connected: !!store.meta("connected_at") && !store.meta("error"),
      error: store.meta("error") || null,
      storage: store.meta("adapter:storage") || "fields",
      notifications: { until: Number(store.meta("adapter:watch_until")) || null, error: store.meta("notify_error") || null },
      last_push: num("last_push"), last_pull: num("last_pull"),
      calls_today: store.callsToday(),
      leads: store.outbox().map(l => {
        const deal = store.link(l.lead_id, "deal"), v = deal ? store.values("deal", deal.remote_id) : {};
        return { ...l, crm_owned: v, crm_fields: { stage: labels[stage]?.[v[stage]] ?? v[stage] ?? null, owner: v[owner] ?? null, amount: v[amount] ?? null } };
      }),
      paused: store.paused(),
      conflicts: store.openConflicts(),
    };
  }
  crmOwned(leadId: string): Props {
    const deal = this.store.link(leadId, "deal");
    return deal ? this.store.values("deal", deal.remote_id) : {};
  }
}

export function tally(list: SyncResult["details"]): SyncResult {
  const count = (o: string) => list.filter(d => d.outcome === o).length;
  return { created: count("created"), updated: count("updated"), skipped: count("skipped") + count("review"), errors: count("error"), details: list };
}
