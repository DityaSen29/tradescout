/**
 * What the sync engine needs from a CRM. There is deliberately no delete and no merge:
 * those only happen when a person does them in the CRM and then approves them here.
 */
export type Kind = "company" | "contact" | "deal";
export const KINDS: readonly Kind[] = ["company", "contact", "deal"];
export type Props = Record<string, string>;

export interface Change { field: string; value: string; at: number }
export interface CrmRecord {
  id: string; props: Props; changes: Change[];
  /** When the record last changed. Its current values count as of this moment. */
  at?: number;
  /** Changes whenever the record does. Saved only after its changes were applied. */
  version?: string;
}

/**
 * Every HTTP attempt goes through this, so every attempt counts against the hard caps.
 * `units` is what the provider charges for the request (HubSpot: 1 a call, Zoho: credits).
 */
export type Meter = <T>(endpoint: string, fn: () => Promise<T>, units?: number) => Promise<T>;
/** Small durable state for an adapter, kept in the ledger's database. Never a secret. */
export interface AdapterState { get(key: string): string; set(key: string, value: string): void }
export interface Limits { run: number; day: number; rolling: boolean }

export interface CrmAdapter {
  readonly name: string;
  /** Our external id, stored on every record. */
  readonly idField: string;
  /** Fields we write. Anything else is never sent. */
  readonly ours: Record<Kind, readonly string[]>;
  /** Fields the CRM owns. Read, never written after create. */
  readonly theirs: Record<Kind, readonly string[]>;
  readonly limits: Limits;
  readonly pollMs: number;
  /** A merged record looks deleted, so a lookalike survivor is offered as a possible merge. */
  readonly mergeLooksDeleted?: boolean;
  /** Called at the start of each operation: drop anything cached for the last one. */
  begin?(): void;
  /** Make values storable (mandatory fields, lengths), the same way on every pass. */
  normalise?(kind: Kind, props: Props): Props;
  connect(): Promise<{ account: string }>;
  ensureSchema(): Promise<void>;
  initialDeal(): Promise<Props>;
  get(kind: Kind, id: string): Promise<CrmRecord | null>;
  findByExternalId(kind: Kind, externalId: string): Promise<CrmRecord | null>;
  /** A domain, an email, or `name:<lower-case company name>` when there is no domain. */
  findByNaturalKey(kind: Kind, value: string): Promise<CrmRecord[]>;
  create(kind: Kind, props: Props): Promise<CrmRecord>;
  update(kind: Kind, id: string, props: Props): Promise<CrmRecord>;
  link(from: Kind, fromId: string, to: Kind, toId: string): Promise<void>;
  /** Records by id, with change history. An id that is absent here was deleted or merged. */
  read(kind: Kind, ids: string[], seen?: (id: string) => string): Promise<CrmRecord[]>;
  /** Readable names for stored values such as stage ids. */
  labels?(): Promise<Record<string, Props>>;
  /** Push notifications, where the CRM lets this credential have them. */
  renewNotifications?(): Promise<void>;
}
export type AdapterFactory = (meter: Meter, state: AdapterState) => CrmAdapter;

export class CrmError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); this.name = "CrmError"; }
  /** Safe to retry: every write looks up by external id before it creates. */
  get retryable() { return this.throttled || this.status === 0 || this.status === 408 || this.status === 412 || this.status >= 500 && this.status !== 501; }
  /** Throttling is the CRM asking us to wait, so it never uses up the attempts. */
  get throttled() { return this.status === 423 || this.status === 429; }
}
export class NotConnected extends CrmError {
  constructor(message: string) { super(401, message); this.name = "NotConnected"; }
}

/** Error text is stored and shown, so it must not carry a work email or a token. */
export const scrub = (v: unknown) => String((v as any)?.message ?? v)
  .replace(/[^\s"'<>:=]+(@|%40)[^\s"'<>]+/g, "[email]")
  .replace(/(1000\.[0-9a-f]{20,}\.[0-9a-f]{20,}|pat-[a-z0-9]+-[0-9a-f-]{20,})/gi, "[token]")
  .slice(0, 300);
