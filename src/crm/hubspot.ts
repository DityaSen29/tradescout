import { CrmError, KINDS, NotConnected, type CrmAdapter, type CrmRecord, type Kind, type Meter, type Props } from "./adapter.js";

/**
 * HubSpot over plain fetch. Auth is a service key (legacy private apps cannot be created since 26 Oct 2026).
 * Service keys cannot receive webhooks, so the engine polls property history.
 */
const BASE = "https://api.hubapi.com";
const PLURAL: Record<Kind, string> = { company: "companies", contact: "contacts", deal: "deals" };
const GROUP: Record<Kind, string> = { company: "companyinformation", contact: "contactinformation", deal: "dealinformation" };
const ID = "meridian_lead_id";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Error text is stored and shown, so it must not carry a work email. */
const scrub = (s: string) => s.replace(/[^\s"'<>:]+@[^\s"'<>]+/g, "[email]").slice(0, 300);

export interface HubSpotOptions { token?: string; fetch?: typeof fetch; gapMs?: number }

export class HubSpot implements CrmAdapter {
  readonly name = "hubspot";
  readonly idField = ID;
  // free accounts allow very few custom properties, so there are five: three ids, match and status
  readonly ours = { company: ["name", "domain"], contact: ["firstname", "lastname", "jobtitle", "email"], deal: ["dealname", "meridian_match", "meridian_status"] };
  readonly theirs = { company: ["hubspot_owner_id"], contact: ["hubspot_owner_id"], deal: ["dealstage", "pipeline", "hubspot_owner_id", "amount"] };
  private last = 0;
  private token: string;
  private http: typeof fetch;
  private gap: number;

  constructor(private meter: Meter, o: HubSpotOptions = {}) {
    this.token = o.token ?? process.env.HUBSPOT_TOKEN ?? "";
    this.http = o.fetch ?? fetch;
    this.gap = o.gapMs ?? 120;                    // free tier: 100 requests per 10 seconds
  }

  private async request<T = any>(method: string, path: string, body?: unknown, label = path): Promise<T> {
    if (!this.token) throw new NotConnected("HUBSPOT_TOKEN is not set");
    const gap = path.endsWith("/search") ? this.gap * 2 : this.gap;   // search allows 5 a second
    const wait = this.last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    return this.meter(`${method} ${label}`, async () => {
      let res: Response, text: string;
      try {
        res = await this.http(BASE + path, {
          method, signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
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
        throw new CrmError(res.status, `HubSpot ${res.status} on ${method} ${label}: ${scrub(String(data?.message ?? "no detail"))}`, after > 0 ? after * 1000 : undefined);
      }
      return data;
    });
  }
  private async orNull<T>(work: Promise<T>): Promise<T | null> {
    try { return await work; } catch (e) { if (e instanceof CrmError && e.status === 404) return null; throw e; }
  }

  /** A 200 without an id and properties is a failure, never "no record". */
  private record(x: any): CrmRecord {
    if (!x?.id || typeof x.properties !== "object") throw new CrmError(502, "HubSpot returned a record without id or properties");
    const props: Props = {};
    for (const [k, v] of Object.entries(x.properties)) props[k] = v == null ? "" : String(v);
    const changes: CrmRecord["changes"] = [];
    for (const [field, list] of Object.entries<any>(x.propertiesWithHistory ?? {}))
      for (const h of list ?? []) {
        const at = Date.parse(h.timestamp);
        if (Number.isFinite(at)) changes.push({ field, value: String(h.value ?? ""), at });
      }
    return { id: String(x.id), props, changes };
  }
  private fields(kind: Kind) { return [ID, ...this.ours[kind], ...this.theirs[kind]]; }

  async connect() {
    const d = await this.request("GET", "/account-info/v3/details");
    if (!d?.portalId) throw new CrmError(502, "HubSpot returned no account id");
    return { account: String(d.portalId) };
  }

  async ensureSchema() {
    for (const kind of KINDS) {
      const names = [ID, ...this.ours[kind].filter(f => f.startsWith("meridian_"))];
      for (const name of names) {
        const path = `/crm/v3/properties/${PLURAL[kind]}/${name}`;
        const found = await this.orNull(this.request("GET", path));
        if (found) {
          if (name === ID && !found.hasUniqueValue) throw new CrmError(409, `${kind}.${ID} exists but is not unique; nothing can be written safely`);
          continue;
        }
        await this.request("POST", `/crm/v3/properties/${PLURAL[kind]}`, {
          name, label: name.replace(/_/g, " ").replace(/^m/, "M"), type: "string", fieldType: "text", groupName: GROUP[kind], hasUniqueValue: name === ID,
        });
      }
    }
  }

  async initialDeal(): Promise<Props> {
    const list: any[] = (await this.request("GET", "/crm/v3/pipelines/deals")).results ?? [];
    const pipeline = [...list].sort((a, b) => a.displayOrder - b.displayOrder)[0];
    const stage = [...(pipeline?.stages ?? [])].sort((a, b) => a.displayOrder - b.displayOrder)[0];
    if (!stage) throw new CrmError(502, "HubSpot has no deal pipeline stage");
    return { pipeline: String(pipeline.id), dealstage: String(stage.id) };
  }

  async get(kind: Kind, id: string) {
    const x = await this.orNull(this.request("GET", `/crm/v3/objects/${PLURAL[kind]}/${encodeURIComponent(id)}?properties=${this.fields(kind).join(",")}`, undefined, `${PLURAL[kind]}/:id`));
    return x && this.record(x);
  }
  async findByExternalId(kind: Kind, externalId: string) {
    const x = await this.orNull(this.request("GET", `/crm/v3/objects/${PLURAL[kind]}/${encodeURIComponent(externalId)}?idProperty=${ID}&properties=${this.fields(kind).join(",")}`, undefined, `${PLURAL[kind]}/:external_id`));
    return x && this.record(x);
  }
  async findByNaturalKey(kind: Kind, value: string) {
    if (kind === "deal" || !value) return [];
    const propertyName = kind === "company" ? "domain" : "email";
    const d = await this.request("POST", `/crm/v3/objects/${PLURAL[kind]}/search`, { filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }], properties: this.fields(kind), limit: 3 });
    if (!Array.isArray(d.results)) throw new CrmError(502, "HubSpot search returned no result list");
    return d.results.map((x: any) => this.record(x));
  }
  async create(kind: Kind, properties: Props) {
    return this.record(await this.request("POST", `/crm/v3/objects/${PLURAL[kind]}`, { properties }));
  }
  async update(kind: Kind, id: string, properties: Props) {
    return this.record(await this.request("PATCH", `/crm/v3/objects/${PLURAL[kind]}/${encodeURIComponent(id)}`, { properties }, `${PLURAL[kind]}/:id`));
  }
  async link(from: Kind, fromId: string, to: Kind, toId: string) {
    await this.request("PUT", `/crm/v4/objects/${PLURAL[from]}/${encodeURIComponent(fromId)}/associations/default/${PLURAL[to]}/${encodeURIComponent(toId)}`, undefined, `${PLURAL[from]}/:id/associations/${PLURAL[to]}`);
  }
  async read(kind: Kind, ids: string[]) {
    const out: CrmRecord[] = [];
    for (let i = 0; i < ids.length; i += 50) {     // 50 is the limit when history is requested
      const d = await this.request("POST", `/crm/v3/objects/${PLURAL[kind]}/batch/read`, {
        properties: this.fields(kind), propertiesWithHistory: this.theirs[kind], inputs: ids.slice(i, i + 50).map(id => ({ id })),
      });
      if (!Array.isArray(d.results)) throw new CrmError(502, "HubSpot batch read returned no result list");
      out.push(...d.results.map((x: any) => this.record(x)));
    }
    return out;
  }
}
