import { CrmError, KINDS, NotConnected, scrub, type AdapterState, type CrmAdapter, type CrmRecord, type Kind, type Meter, type Props } from "./adapter.js";
import { Batcher, Pace, eachAlone } from "./batch.js";
import type { TokenSource } from "./oauth.js";

/**
 * HubSpot over plain fetch, with a service key, a static app token or OAuth.
 * Service keys cannot receive webhooks, so polling of property history is the default.
 */
const BASE = "https://api.hubapi.com";
const PLURAL: Record<Kind, string> = { company: "companies", contact: "contacts", deal: "deals" };
const GROUP: Record<Kind, string> = { company: "companyinformation", contact: "contactinformation", deal: "dealinformation" };
const ID = "meridian_lead_id";

export interface HubSpotOptions { token?: string; tokens?: TokenSource; fetch?: typeof fetch; gapMs?: number; state?: AdapterState }
type Lookup = Batcher<string, CrmRecord | null>;

export class HubSpot implements CrmAdapter {
  readonly name = "hubspot";
  readonly idField = ID;
  // free accounts allow very few custom properties, so there are five: three ids, match and status
  readonly ours = { company: ["name", "domain"], contact: ["firstname", "lastname", "jobtitle", "email"], deal: ["dealname", "meridian_match", "meridian_status"] };
  readonly theirs = { company: ["hubspot_owner_id"], contact: ["hubspot_owner_id"], deal: ["dealstage", "pipeline", "hubspot_owner_id", "amount"] };
  readonly limits = { run: 2000, day: 10_000, rolling: false };
  readonly pollMs = 60_000;
  private pace: Pace;
  private http: typeof fetch;
  private batchers = new Map<string, Batcher<any, any>>();

  constructor(private meter: Meter, private o: HubSpotOptions = {}) {
    this.http = o.fetch ?? fetch;
    this.pace = new Pace(5, o.gapMs ?? 120);               // free tier: 100 requests per 10 seconds
  }

  private async request<T = any>(method: string, path: string, body?: unknown, label = path.split("?")[0], rejected?: string): Promise<T> {
    let token = this.o.token ?? "";
    if (this.o.tokens) token = await this.o.tokens.get(this.meter, rejected);
    else if (!token) token = process.env.HUBSPOT_TOKEN ?? "";
    if (!token) throw new NotConnected("HUBSPOT_TOKEN is not set");
    try {
      // search allows 5 requests a second
      return await this.pace.run(() => this.meter(`${method} ${label}`, () => this.send<T>(method, path, token, body, label)), path.endsWith("/search") ? 2 : 1);
    } catch (e) {
      if (!(e instanceof NotConnected)) throw e;
      if (this.o.tokens && !rejected) return this.request(method, path, body, label, token);
      throw e;
    }
  }
  private async send<T>(method: string, path: string, token: string, body: unknown, label: string): Promise<T> {
    let res: Response, text: string;
    try {
      res = await this.http(BASE + path, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (e: any) { throw new CrmError(0, `HubSpot unreachable: ${e?.name ?? "network error"}`); }
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { if (res.ok) throw new CrmError(502, `HubSpot returned invalid JSON on ${label}`); }
    if (res.status === 401) throw new NotConnected("HubSpot rejected the key (401)");
    if (!res.ok) {
      const after = Number(res.headers.get("retry-after"));
      throw new CrmError(res.status, `HubSpot ${res.status} on ${method} ${label}: ${scrub(data?.message ?? "no detail")}`, after > 0 ? after * 1000 : undefined);
    }
    return data;
  }
  private async orNull<T>(work: Promise<T>): Promise<T | null> {
    try { return await work; } catch (e) { if (e instanceof CrmError && e.status === 404) return null; throw e; }
  }

  /** A 200 without an id and properties is a failure, never "no record". */
  private record(x: any): CrmRecord {
    if (!x?.id || !x.properties || typeof x.properties !== "object") throw new CrmError(502, "HubSpot returned a record without id or properties");
    const props: Props = {};
    for (const [k, v] of Object.entries(x.properties)) props[k] = v == null ? "" : String(v);
    const changes: CrmRecord["changes"] = [];
    for (const [field, list] of Object.entries<any>(x.propertiesWithHistory ?? {}))
      for (const h of list ?? []) {
        const at = Date.parse(h.timestamp);
        if (Number.isFinite(at)) changes.push({ field, value: String(h.value ?? ""), at });
      }
    return { id: String(x.id), props, changes, at: Date.parse(x.updatedAt) || undefined };
  }
  private fields(kind: Kind) { return [ID, ...this.ours[kind], ...this.theirs[kind]]; }
  private path(kind: Kind) { return `/crm/v3/objects/${PLURAL[kind]}`; }
  private batcher<I, O>(key: string, max: number, run: (items: I[]) => Promise<(O | Error)[]>): Batcher<I, O> {
    let b = this.batchers.get(key);
    if (!b) this.batchers.set(key, (b = new Batcher<I, O>(max, run)));
    return b;
  }
  private results(d: any, what: string): any[] {
    if (!Array.isArray(d?.results)) throw new CrmError(502, `HubSpot ${what} returned no result list`);
    return d.results;
  }

  async connect() {
    const d = await this.request("GET", "/account-info/v3/details");
    if (!d?.portalId) throw new CrmError(502, "HubSpot returned no account id");
    return { account: String(d.portalId) };
  }

  async ensureSchema() {
    for (const kind of KINDS)
      for (const name of [ID, ...this.ours[kind].filter(f => f.startsWith("meridian_"))]) {
        const base = `/crm/v3/properties/${PLURAL[kind]}`;
        const found = await this.orNull(this.request("GET", `${base}/${name}`));
        if (found) {
          if (name === ID && !found.hasUniqueValue) throw new CrmError(409, `${kind}.${ID} exists but is not unique; nothing can be written safely`);
          continue;
        }
        await this.request("POST", base, { name, label: name.replace(/_/g, " ").replace(/^m/, "M"), type: "string", fieldType: "text", groupName: GROUP[kind], hasUniqueValue: name === ID });
      }
  }

  private async pipelines(): Promise<any[]> {
    return [...((await this.request("GET", "/crm/v3/pipelines/deals")).results ?? [])].sort((a, b) => a.displayOrder - b.displayOrder);
  }
  async initialDeal(): Promise<Props> {
    const pipeline = (await this.pipelines())[0];
    const stage = [...(pipeline?.stages ?? [])].sort((a, b) => a.displayOrder - b.displayOrder)[0];
    if (!stage) throw new CrmError(502, "HubSpot has no deal pipeline stage");
    return { pipeline: String(pipeline.id), dealstage: String(stage.id) };
  }
  async labels() {
    const list = await this.pipelines(), out: Record<string, Props> = { pipeline: {}, dealstage: {} };
    for (const p of list) {
      if (p.label) out.pipeline[p.id] = String(p.label);
      for (const s of p.stages ?? []) if (s.label) out.dealstage[s.id] = String(s.label);
    }
    return out;
  }

  // ---- reads
  private getOne = async (kind: Kind, id: string) => {
    const x = await this.orNull(this.request("GET", `${this.path(kind)}/${encodeURIComponent(id)}?properties=${this.fields(kind).join(",")}`, undefined, `${PLURAL[kind]}/:id`));
    return x && this.record(x);
  };
  private findOne = async (kind: Kind, externalId: string) => {
    const x = await this.orNull(this.request("GET", `${this.path(kind)}/${encodeURIComponent(externalId)}?idProperty=${ID}&properties=${this.fields(kind).join(",")}`, undefined, `${PLURAL[kind]}/:external_id`));
    return x && this.record(x);
  };
  get(kind: Kind, id: string): Promise<CrmRecord | null> {
    const b: Lookup = this.batcher(`get:${kind}`, 100, async (ids: string[]) => {
      if (ids.length === 1) return [await this.getOne(kind, ids[0])];
      const d = await this.request("POST", `${this.path(kind)}/batch/read`, { properties: this.fields(kind), inputs: [...new Set(ids)].map(id => ({ id })) });
      const found = new Map(this.results(d, "batch read").map(x => [String(x.id), this.record(x)]));
      // asked alone, a missing id says whether it was deleted or merged
      return eachAlone(ids, async i => found.get(i) ?? this.getOne(kind, i));
    });
    return b.load(id);
  }
  findByExternalId(kind: Kind, externalId: string): Promise<CrmRecord | null> {
    const b: Lookup = this.batcher(`find:${kind}`, 100, async (ids: string[]) => {
      if (ids.length === 1) return [await this.findOne(kind, ids[0])];
      const d = await this.request("POST", `${this.path(kind)}/batch/read`, { idProperty: ID, properties: this.fields(kind), inputs: [...new Set(ids)].map(id => ({ id })) });
      const other = (d.errors ?? []).find((e: any) => e.category && e.category !== "OBJECT_NOT_FOUND");
      if (other) throw new CrmError(502, `HubSpot batch lookup failed: ${scrub(other.message)}`);
      const found = new Map(this.results(d, "batch lookup").map(x => [String(x.properties?.[ID]), this.record(x)]));
      return ids.map(i => found.get(i) ?? null);
    });
    return b.load(externalId);
  }
  findByNaturalKey(kind: Kind, value: string): Promise<CrmRecord[]> {
    if (kind === "deal" || !value) return Promise.resolve([]);
    const byName = value.startsWith("name:"), propertyName = byName ? "name" : kind === "company" ? "domain" : "email";
    const b = this.batcher<string, CrmRecord[]>(`search:${kind}:${propertyName}`, 50, async values => {
      const search = async (filter: object, limit: number) => {
        const d = await this.request("POST", `${this.path(kind)}/search`, { filterGroups: [{ filters: [{ propertyName, ...filter }] }], properties: this.fields(kind), limit });
        return { more: !!d.paging?.next, rows: this.results(d, "search").map(x => this.record(x)) };
      };
      const one = async (v: string) => (await search({ operator: "EQ", value: v }, 3)).rows;
      if (values.length === 1) return [await one(values[0])];
      const all = await search({ operator: "IN", values: [...new Set(values.map(v => v.toLowerCase()))] }, 100);
      if (all.more) return eachAlone(values, one);
      return values.map(v => all.rows.filter(r => r.props[propertyName]?.toLowerCase() === v.toLowerCase()));
    });
    return b.load(byName ? value.slice(5) : value);
  }

  // ---- writes
  create(kind: Kind, properties: Props): Promise<CrmRecord> {
    const alone = async (p: Props) => this.record(await this.request("POST", this.path(kind), { properties: p }));
    const b = this.batcher<Props, CrmRecord>(`create:${kind}`, 100, async items => {
      if (items.length === 1) return [await alone(items[0])];
      let d: any;
      try { d = await this.request("POST", `${this.path(kind)}/batch/create`, { inputs: items.map(p => ({ properties: p })) }); }
      catch (e) {
        // one bad row refuses the batch, so find it; nothing was written
        if (e instanceof CrmError && (e.status === 400 || e.status === 409)) return eachAlone(items, alone);
        throw e;
      }
      const made = new Map(this.results(d, "batch create").map(x => [String(x.properties?.[ID]), this.record(x)]));
      return items.map(p => made.get(p[ID]) ?? new CrmError(502, "HubSpot did not confirm this create; it will be looked up again"));
    });
    return b.load(properties);
  }
  update(kind: Kind, id: string, properties: Props): Promise<CrmRecord> {
    type Item = { id: string; properties: Props };
    const alone = async (i: Item) => this.record(await this.request("PATCH", `${this.path(kind)}/${encodeURIComponent(i.id)}`, { properties: i.properties }, `${PLURAL[kind]}/:id`));
    const b = this.batcher<Item, CrmRecord>(`update:${kind}`, 100, async items => {
      if (items.length === 1 || new Set(items.map(i => i.id)).size < items.length) return eachAlone(items, alone);
      let d: any;
      try { d = await this.request("POST", `${this.path(kind)}/batch/update`, { inputs: items }); }
      catch (e) {
        if (e instanceof CrmError && [400, 404, 409].includes(e.status)) return eachAlone(items, alone);
        throw e;
      }
      const done = new Map(this.results(d, "batch update").map(x => [String(x.id), this.record(x)]));
      return items.map(i => done.get(i.id) ?? new CrmError(502, "HubSpot did not confirm this update"));
    });
    return b.load({ id, properties });
  }
  async link(from: Kind, fromId: string, to: Kind, toId: string): Promise<void> {
    type Pair = [string, string];
    const a = PLURAL[from], z = PLURAL[to];
    const alone = async ([f, t]: Pair) => {
      await this.request("PUT", `/crm/v4/objects/${a}/${encodeURIComponent(f)}/associations/default/${z}/${encodeURIComponent(t)}`, undefined, `${a}/:id/associations/${z}`);
      return true;
    };
    const b = this.batcher<Pair, boolean>(`link:${from}:${to}`, 100, async pairs => {
      if (pairs.length === 1) return [await alone(pairs[0])];
      const d = await this.request("POST", `/crm/v4/associations/${a}/${z}/batch/associate/default`, { inputs: pairs.map(([f, t]) => ({ from: { id: f }, to: { id: t } })) });
      if (d.numErrors || d.errors?.length) return eachAlone(pairs, alone);
      return pairs.map(() => true);
    });
    await b.load([fromId, toId]);
  }

  async read(kind: Kind, ids: string[]) {
    const out: CrmRecord[] = [];
    for (let i = 0; i < ids.length; i += 50) {              // 50 is the limit when history is requested
      const d = await this.request("POST", `${this.path(kind)}/batch/read`, { properties: this.fields(kind), propertiesWithHistory: this.theirs[kind], inputs: ids.slice(i, i + 50).map(id => ({ id })) });
      out.push(...this.results(d, "batch read").map(x => this.record(x)));
    }
    return out;
  }
}
