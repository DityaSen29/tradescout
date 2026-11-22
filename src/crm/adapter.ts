/**
 * What the sync engine needs from a CRM. There is deliberately no delete and no merge:
 * those only happen when a person does them in the CRM and then approves them here.
 */
export type Kind = "company" | "contact" | "deal";
export const KINDS: readonly Kind[] = ["company", "contact", "deal"];
export type Props = Record<string, string>;

export interface Change { field: string; value: string; at: number }
export interface CrmRecord { id: string; props: Props; changes: Change[] }

/** Every HTTP attempt goes through this, so every attempt counts against the hard caps. */
export type Meter = <T>(endpoint: string, fn: () => Promise<T>) => Promise<T>;

export interface CrmAdapter {
  readonly name: string;
  /** Our external id, stored on every record. */
  readonly idField: string;
  /** Fields we write. Anything else is never sent. */
  readonly ours: Record<Kind, readonly string[]>;
  /** Fields the CRM owns. Read, never written after create. */
  readonly theirs: Record<Kind, readonly string[]>;
  connect(): Promise<{ account: string }>;
  ensureSchema(): Promise<void>;
  initialDeal(): Promise<Props>;
  get(kind: Kind, id: string): Promise<CrmRecord | null>;
  findByExternalId(kind: Kind, externalId: string): Promise<CrmRecord | null>;
  findByNaturalKey(kind: Kind, value: string): Promise<CrmRecord[]>;
  create(kind: Kind, props: Props): Promise<CrmRecord>;
  update(kind: Kind, id: string, props: Props): Promise<CrmRecord>;
  link(from: Kind, fromId: string, to: Kind, toId: string): Promise<void>;
  /** Records by id, with change history. An id that is absent here was deleted or merged. */
  read(kind: Kind, ids: string[]): Promise<CrmRecord[]>;
}
export type AdapterFactory = (meter: Meter) => CrmAdapter;

export class CrmError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); this.name = "CrmError"; }
  /** Safe to retry: every write looks up by external id before it creates. */
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 423 || this.status === 429 || this.status >= 500; }
}
export class NotConnected extends CrmError {
  constructor(message: string) { super(401, message); this.name = "NotConnected"; }
}
