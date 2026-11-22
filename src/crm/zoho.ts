import { randomInt } from "node:crypto";
import { CrmError, KINDS, NotConnected, scrub, type AdapterState, type CrmAdapter, type CrmRecord, type Kind, type Meter, type Props } from "./adapter.js";
import { Batcher, Pace, eachAlone } from "./batch.js";
import { zohoApi } from "./credentials.js";
import type { TokenSource } from "./oauth.js";

/**
 * Zoho CRM API v8. Three things it does differently, all from its docs:
 * - Search lags behind writes, so every lookup uses COQL or the records list, never search. A lagging lookup would make duplicates.
 * - The Free edition has no custom fields. There, our three values are lines at the top of Description
 *   and are found by listing the module. Where custom fields exist, the id is a unique field.
 * - Writes run workflows by default, and a workflow can email the buyer. Every write sends `trigger: []`.
 */
const MODULE: Record<Kind, string> = { company: "Accounts", contact: "Contacts", deal: "Deals" };
const ID = "Meridian_Lead_Id", MATCH = "Meridian_Match", STATUS = "Meridian_Status";
const LINES: Record<string, string> = { [ID]: "Meridian ref", [MATCH]: "Meridian match", [STATUS]: "Meridian status" };
const OPTIONAL_LABEL: Record<string, string> = { [ID]: "Meridian Lead Id", [MATCH]: "Meridian Match", [STATUS]: "Meridian Status" };
const MAX: Record<string, number> = { Account_Name: 200, Website: 255, First_Name: 40, Last_Name: 80, Title: 100, Email: 100, Deal_Name: 120, [MATCH]: 255, [STATUS]: 255 };
const LOOKUP: Partial<Record<`${Kind}>${Kind}`, string>> = { "contact>company": "Account_Name", "deal>company": "Account_Name", "deal>contact": "Contact_Name" };
const SUPPRESS = { trigger: [], skip_feature_execution: [{ name: "cadences" }] };

const str = (v: any): string => (v == null ? "" : typeof v === "object" ? String(v.name ?? v.id ?? "") : String(v));
const quote = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** COQL wants every pair bracketed. */
const anyOf = (terms: string[]): string => (terms.length === 1 ? `(${terms[0]})` : `(${anyOf(terms.slice(0, Math.ceil(terms.length / 2)))} or ${anyOf(terms.slice(Math.ceil(terms.length / 2)))})`);
const host = (v: string) => v.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

export function readLine(description: string, field: string): string {
  const prefix = `${LINES[field]}: `;
  return description.split(/\r?\n/).find(l => l.startsWith(prefix))?.slice(prefix.length).trim() ?? "";
}
/** Changes only our lines. Everything a person wrote stays. */
export function writeLines(description: string, values: Props): string {
  let lines = description ? description.split(/\r?\n/) : [];
  for (const [field, value] of Object.entries(values)) {
    const prefix = `${LINES[field]}: `, at = lines.findIndex(l => l.startsWith(prefix));
    const line = value ? [`${prefix}${value.replace(/[\r\n]+/g, " ")}`] : [];
    if (at >= 0) lines.splice(at, 1, ...line);
    else {
      let top = 0;
      while (top < lines.length && Object.values(LINES).some(p => lines[top].startsWith(`${p}: `))) top++;
      lines.splice(top, 0, ...line);
    }
  }
  return lines.join("\n");
}

export interface ZohoOptions {
  tokens: TokenSource;
  state: AdapterState;
  fetch?: typeof fetch;
  gapMs?: number;
  /** A public HTTPS address for Zoho's notifications. Without one, polling alone is used. */
  notifyUrl?: string;
}

export class Zoho implements CrmAdapter {
  readonly name = "zoho";
  readonly idField = ID;
  readonly ours = { company: ["Account_Name", "Website"], contact: ["First_Name", "Last_Name", "Title", "Email"], deal: ["Deal_Name", MATCH, STATUS] };
  readonly theirs = { company: ["Owner"], contact: ["Owner"], deal: ["Stage", "Pipeline", "Owner", "Amount"] };
  // Free allows 5,000 credits in any 24 hours. Leave room for the person's own integrations.
  readonly limits = { run: 2000, day: 4000, rolling: true };
  readonly pollMs = 180_000;
  readonly mergeLooksDeleted = true;
  private http: typeof fetch;
  private pace: Pace;
  private org: { account: string; free: boolean; until: number } | null = null;
  private index = new Map<Kind, Promise<Map<string, string>>>();
  private batchers = new Map<string, Batcher<any, any>>();

  constructor(private meter: Meter, private o: ZohoOptions) {
    this.http = o.fetch ?? fetch;
    this.pace = new Pace(4, o.gapMs ?? 50);                // Free allows 5 requests open at once
  }
  begin() { this.index.clear(); }

  normalise(kind: Kind, props: Props): Props {
    const p = { ...props };
    if (kind === "contact" && !p.Last_Name) {              // Last_Name is mandatory in Zoho
      p.Last_Name = p.First_Name || (p.Email ? p.Email.split("@")[0] : "Unknown");
      delete p.First_Name;
    }
    for (const [k, v] of Object.entries(p)) if (MAX[k]) p[k] = v.slice(0, MAX[k]).trim();
    return p;
  }

  private async request(method: string, path: string, o: { body?: unknown; units?: number; headers?: Record<string, string>; rejected?: string } = {}): Promise<{ status: number; data: any }> {
    const token = await this.o.tokens.get(this.meter, o.rejected);
    const c = this.o.tokens.connection();
    if (!c.api_url) throw new NotConnected("Zoho has no API address yet; sign in again");
    const base = `${zohoApi(c.api_url)}/crm/v8`, label = `${method} zoho${path.split("?")[0].replace(/\/\d{6,}/g, "/:id")}`;
    try {
      return await this.pace.run(() => this.meter(label, () => this.send(method, base + path, token, o.body, o.headers, label), o.units ?? 1));
    } catch (e) {
      if (e instanceof CrmError && e.status === 401 && e.message.includes("INVALID_TOKEN") && !o.rejected) return this.request(method, path, { ...o, rejected: token });
      throw e;
    }
  }
  private async send(method: string, url: string, token: string, body: unknown, headers: Record<string, string> | undefined, label: string) {
    let res: Response, text: string;
    try {
      res = await this.http(url, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Zoho-oauthtoken ${token}`, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch (e: any) { throw new CrmError(0, `Zoho unreachable: ${e?.name ?? "network error"}`); }
    if (res.status === 204 || res.status === 304) return { status: res.status, data: null };
    let data: any;
    try { data = text ? JSON.parse(text) : null; }
    catch { if (res.ok) throw new CrmError(502, `Zoho returned invalid JSON on ${label}`); }
    if (res.status === 401) {
      if (/INVALID_TOKEN|INVALID_OAUTHTOKEN/.test(String(data?.code))) throw new NotConnected("Zoho rejected the token (INVALID_TOKEN)");
      throw new NotConnected(`Zoho refused access: ${scrub(data?.code ?? 401)}. Sign in again with every listed scope`);
    }
    // a refused single write still carries its row, and the row says why
    if (res.ok || (Array.isArray(data?.data) && res.status < 429)) {
      if (data == null) throw new CrmError(502, `Zoho returned an empty answer on ${label}`);
      return { status: res.status, data };
    }
    const why = data?.fields?.[0] ?? data?.watch?.[0] ?? data, after = Number(res.headers.get("retry-after"));
    throw new CrmError(res.status, `Zoho ${res.status} on ${label}: ${scrub(`${why?.code ?? ""} ${why?.message ?? "no detail"}`)}`, after > 0 ? after * 1000 : res.status === 429 ? 30_000 : undefined);
  }
  private batcher<I, O>(key: string, max: number, run: (items: I[]) => Promise<(O | Error)[]>): Batcher<I, O> {
    let b = this.batchers.get(key);
    if (!b) this.batchers.set(key, (b = new Batcher<I, O>(max, run)));
    return b;
  }

  // ---- setup
  private async readOrg() {
    if (this.org && this.org.until > Date.now()) return this.org;
    const org = (await this.request("GET", "/org")).data?.org?.[0];
    if (!org?.id) throw new CrmError(502, "Zoho returned no organisation id");
    const licence = org.license_details ?? {};
    const free = org.type === "production" && (licence.paid_type === "free" || (licence.paid === false && !licence.trial_type));
    return (this.org = { account: String(org.id), free, until: Date.now() + 3_600_000 });
  }
  async connect() { return { account: (await this.readOrg()).account }; }

  private get inDescription() { return this.o.state.get("storage") === "description"; }
  private async moduleFields(kind: Kind): Promise<any[]> {
    const list = (await this.request("GET", `/settings/fields?module=${MODULE[kind]}`)).data?.fields;
    if (!Array.isArray(list)) throw new CrmError(502, "Zoho returned no field list");
    return list;
  }
  async ensureSchema() {
    const existing = await this.moduleFields("deal");
    // fixed once: records written one way cannot be found the other way
    let storage = this.o.state.get("storage");
    if (!storage) storage = existing.some(f => f.api_name === ID) ? "fields" : (await this.readOrg()).free ? "description" : "fields";
    if (storage === "fields")
      for (const kind of KINDS) {
        const want = kind === "deal" ? [ID, MATCH, STATUS] : [ID];
        let have = kind === "deal" ? existing : await this.moduleFields(kind);
        const missing = want.filter(n => !have.some(f => f.api_name === n));
        if (missing.length) {
          const fields = missing.map(n => ({ field_label: OPTIONAL_LABEL[n], data_type: "text", length: 255, ...(n === ID ? { unique: { case_sensitive: false } } : {}) }));
          await this.request("POST", `/settings/fields?module=${MODULE[kind]}`, { body: { fields }, units: 10 * fields.length });
          have = await this.moduleFields(kind);
        }
        for (const n of want) {
          const f = have.find(x => x.api_name === n);
          if (!f) throw new CrmError(409, `Zoho did not create ${MODULE[kind]}.${n}; nothing can be written safely`);
          if (n === ID && !(f.unique && Object.keys(f.unique).length)) throw new CrmError(409, `Zoho ${MODULE[kind]}.${n} exists but is not unique; nothing can be written safely`);
        }
      }
    this.o.state.set("storage", storage);
  }

  async initialDeal(): Promise<Props> {
    const layouts: any[] = (await this.request("GET", "/settings/layouts?module=Deals")).data?.layouts ?? [];
    const active = layouts.filter(l => !l.status || l.status === "active"), layout = active.find(l => l.name === "Standard") ?? active[0];
    if (!layout?.id) throw new CrmError(502, "Zoho returned no Deals layout");
    const fields: any[] = (layout.sections ?? []).flatMap((s: any) => s.fields ?? []);
    const named = (n: string) => fields.find(f => f.api_name === n);
    const out: Props = {};
    let pipelines: any[] = [];
    if (named("Pipeline")) pipelines = (await this.request("GET", `/settings/pipeline?layout_id=${layout.id}`)).data?.pipeline ?? [];
    const pipeline = pipelines.find(p => p.default) ?? pipelines[0];
    const stages: any[] = pipeline?.maps ?? named("Stage")?.pick_list_values ?? [];
    const stage = [...stages].sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0)).find(s => s.actual_value && s.actual_value !== "-None-");
    if (!stage) throw new CrmError(502, "Zoho returned no deal stage");
    out.Stage = String(stage.actual_value);
    if (pipeline) out.Pipeline = String(pipeline.actual_value);
    const closing = named("Closing_Date");
    // set only where the layout insists on one
    if (closing?.required || closing?.system_mandatory) out.Closing_Date = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    return out;
  }

  // ---- records
  private columns(kind: Kind): string[] {
    const real = [...this.ours[kind], ...this.theirs[kind]].filter(f => !this.inDescription || !LINES[f]);
    const links = kind === "contact" ? ["Account_Name"] : kind === "deal" ? ["Account_Name", "Contact_Name"] : [];
    return [...new Set([...real, ...links, this.inDescription ? "Description" : ID, "Modified_Time"])];
  }
  private record(kind: Kind, x: any): CrmRecord {
    if (!x?.id) throw new CrmError(502, "Zoho returned a record without an id");
    const props: Props = {};
    for (const f of this.columns(kind)) props[f] = str(x[f]);
    if (this.inDescription) for (const f of [ID, ...this.ours[kind].filter(f => LINES[f])]) props[f] = readLine(props.Description ?? "", f);
    if (kind === "company" && props.Website) props.Website = host(props.Website);
    return { id: String(x.id), props, changes: [], at: Date.parse(x.Modified_Time) || undefined, version: JSON.stringify([x.Modified_Time, this.theirs[kind].map(f => props[f])]) };
  }
  private async fetchMany(kind: Kind, ids: string[]): Promise<Map<string, CrmRecord>> {
    const out = new Map<string, CrmRecord>(), list = [...new Set(ids)].filter(id => /^\d+$/.test(id));
    for (let i = 0; i < list.length; i += 100) {
      const d = await this.request("GET", `/${MODULE[kind]}?ids=${list.slice(i, i + 100).join(",")}&fields=${this.columns(kind).join(",")}&per_page=200`);
      if (d.status === 204) continue;
      if (!Array.isArray(d.data?.data)) throw new CrmError(502, "Zoho records read returned no list");
      for (const x of d.data.data) { const r = this.record(kind, x); out.set(r.id, r); }
    }
    return out;
  }
  private async query(select: string): Promise<any[]> {
    const d = await this.request("POST", "/coql", { body: { select_query: select } });
    if (d.status === 204) return [];
    if (!Array.isArray(d.data?.data)) throw new CrmError(502, "Zoho query returned no list");
    if (d.data.info?.more_records) throw new CrmError(409, "too many Zoho records match to rule out a duplicate; narrow them in the CRM");
    return d.data.data;
  }

  get(kind: Kind, id: string): Promise<CrmRecord | null> {
    return this.batcher<string, CrmRecord | null>(`get:${kind}`, 100, async ids => {
      const found = await this.fetchMany(kind, ids);
      return ids.map(i => found.get(i) ?? null);
    }).load(id);
  }

  /** The Free-edition index: every record's ref line. An incomplete list is an error, because it would allow a duplicate. */
  private async scan(kind: Kind): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let token = "";
    for (let page = 0; page < 500; page++) {
      const d = await this.request("GET", `/${MODULE[kind]}?fields=Description&per_page=200${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
      if (d.status === 204) return out;
      if (!Array.isArray(d.data?.data)) throw new CrmError(502, "Zoho records list returned no list");
      for (const x of d.data.data) { const ref = readLine(str(x.Description), ID); if (ref && !out.has(ref)) out.set(ref, String(x.id)); }
      if (!d.data.info?.more_records) return out;
      token = d.data.info.next_page_token ?? "";
      if (!token) throw new CrmError(502, "Zoho records list had more pages and no page token");
    }
    throw new CrmError(409, "too many records to check for duplicates on the Free edition");
  }
  findByExternalId(kind: Kind, externalId: string): Promise<CrmRecord | null> {
    return this.batcher<string, CrmRecord | null>(`find:${kind}`, 50, async refs => {
      let ids: string[];
      if (this.inDescription) {
        let index = this.index.get(kind);
        if (!index) this.index.set(kind, (index = this.scan(kind)));
        const map = await index;
        ids = refs.flatMap(r => map.get(r) ?? []);
      } else {
        const unique = [...new Set(refs)];
        const where = unique.length === 1 ? `${ID} = ${quote(unique[0])}` : `${ID} in (${unique.map(quote).join(",")})`;
        ids = (await this.query(`select id from ${MODULE[kind]} where ${where} limit 200`)).map(x => String(x.id));
      }
      const found = [...(ids.length ? await this.fetchMany(kind, ids) : new Map<string, CrmRecord>()).values()];
      return refs.map(r => found.find(f => f.props[ID] === r) ?? null);
    }).load(externalId);
  }
  findByNaturalKey(kind: Kind, value: string): Promise<CrmRecord[]> {
    if (kind === "deal" || !value) return Promise.resolve([]);
    const byName = value.startsWith("name:"), field = byName ? "Account_Name" : kind === "company" ? "Website" : "Email";
    return this.batcher<string, CrmRecord[]>(`natural:${kind}:${field}`, 20, async values => {
      // Website may hold https://www.x.com/, so it is matched loosely and then compared exactly
      const terms = [...new Set(values)].map(v => (field === "Website" ? `${field} like ${quote(`%${v}%`)}` : `${field} = ${quote(v)}`));
      let rows: any[];
      try { rows = await this.query(`select id from ${MODULE[kind]} where ${anyOf(terms)} limit 200`); }
      catch (e) {
        // too broad together is often fine apart
        if (e instanceof CrmError && e.status === 409 && values.length > 1) return eachAlone(values, v => this.findByNaturalKey(kind, byName ? `name:${v}` : v));
        throw e;
      }
      const found = [...(rows.length ? await this.fetchMany(kind, rows.map(x => String(x.id))) : new Map<string, CrmRecord>()).values()];
      return values.map(v => found.filter(r => r.props[field]?.toLowerCase() === v.toLowerCase()));
    }).load(byName ? value.slice(5) : value);
  }

  private body(props: Props, description = ""): Record<string, unknown> {
    const out: Record<string, unknown> = {}, lines: Props = {};
    for (const [k, v] of Object.entries(props)) {
      if (this.inDescription && LINES[k]) lines[k] = v;
      else out[k] = v === "" ? null : v;
    }
    if (Object.keys(lines).length) out.Description = writeLines(description, lines);
    return out;
  }
  private rowError(row: any): CrmError {
    const status = ({ DUPLICATE_DATA: 409, RECORD_LOCKED: 423, TOO_MANY_REQUESTS: 429, INTERNAL_ERROR: 500, ALREADY_MODIFIED: 412 } as Record<string, number>)[row?.code] ?? 400;
    return new CrmError(status, scrub(`Zoho ${row?.code ?? "error"}: ${row?.message ?? "no detail"}${row?.details?.api_name ? ` (${row.details.api_name})` : ""}`));
  }
  create(kind: Kind, props: Props): Promise<CrmRecord> {
    return this.batcher<Props, CrmRecord>(`create:${kind}`, 100, async items => {
      const { data } = await this.request("POST", `/${MODULE[kind]}`, { units: Math.ceil(items.length / 10), body: { data: items.map(p => this.body(p)), ...SUPPRESS } });
      if (!Array.isArray(data?.data)) throw new CrmError(502, "Zoho create returned no list");
      const out: (CrmRecord | Error)[] = [];
      for (const [n, p] of items.entries()) {
        const row = data.data[n];
        if (row?.code === "SUCCESS" && row.details?.id) {
          const id = String(row.details.id);
          out.push({ id, props: { ...p }, changes: [] });
          if (this.inDescription && p[ID]) await this.index.get(kind)?.then(m => m.set(p[ID], id));
        } else out.push(this.rowError(row));
      }
      return out;
    }).load(props);
  }
  update(kind: Kind, id: string, props: Props): Promise<CrmRecord> {
    type Item = { id: string; props: Props };
    const done = (i: Item, row: any): CrmRecord | Error => (row?.code === "SUCCESS" ? { id: i.id, props: { ...i.props }, changes: [] } : this.rowError(row));
    const alone = async (i: Item): Promise<CrmRecord> => {
      // Description is shared with people: read it, change our lines, and refuse if it moved meanwhile
      const now = (await this.request("GET", `/${MODULE[kind]}/${i.id}`)).data?.data?.[0];
      if (!now) throw new CrmError(404, "the Zoho record is gone");
      const headers = now.Modified_Time ? { "If-Unmodified-Since": String(now.Modified_Time) } : undefined;
      const { data } = await this.request("PUT", `/${MODULE[kind]}`, { headers, body: { data: [{ id: i.id, ...this.body(i.props, str(now.Description)) }], ...SUPPRESS } });
      const r = done(i, data?.data?.[0]);
      if (r instanceof Error) throw r;
      return r;
    };
    return this.batcher<Item, CrmRecord>(`update:${kind}`, 100, async items => {
      const shared = this.inDescription && items.some(i => Object.keys(i.props).some(k => LINES[k]));
      if (shared || new Set(items.map(i => i.id)).size < items.length) return eachAlone(items, alone);
      const { data } = await this.request("PUT", `/${MODULE[kind]}`, { units: Math.ceil(items.length / 10), body: { data: items.map(i => ({ id: i.id, ...this.body(i.props) })), ...SUPPRESS } });
      if (!Array.isArray(data?.data)) throw new CrmError(502, "Zoho update returned no list");
      return items.map((i, n) => done(i, data.data[n]));
    }).load({ id, props });
  }
  async link(from: Kind, fromId: string, to: Kind, toId: string): Promise<void> {
    const field = LOOKUP[`${from}>${to}`];
    if (!field) throw new CrmError(400, `Zoho has no ${from} to ${to} lookup`);
    await this.batcher<[string, string], boolean>(`link:${from}:${to}`, 100, async pairs => {
      const now = await this.fetchMany(from, pairs.map(p => p[0]));
      // only fill a blank lookup: a person may have pointed it elsewhere
      const todo = pairs.filter(([f]) => now.has(f) && !now.get(f)!.props[field]);
      const failed = new Map<string, Error>();
      if (todo.length) {
        const { data } = await this.request("PUT", `/${MODULE[from]}`, { units: Math.ceil(todo.length / 10), body: { data: todo.map(([f, t]) => ({ id: f, [field]: { id: t } })), ...SUPPRESS } });
        todo.forEach(([f], n) => { if (data?.data?.[n]?.code !== "SUCCESS") failed.set(f, this.rowError(data?.data?.[n])); });
      }
      return pairs.map(([f]) => failed.get(f) ?? true);
    }).load([fromId, toId]);
  }

  // ---- inbound
  async read(kind: Kind, ids: string[], seen: (id: string) => string = () => "") {
    const records = [...(await this.fetchMany(kind, ids)).values()];
    for (const r of records) if (seen(r.id) !== r.version) r.changes = await this.history(kind, r.id);
    return records;
  }
  private async history(kind: Kind, id: string): Promise<CrmRecord["changes"]> {
    const out: CrmRecord["changes"] = [];
    let token = "";
    for (let page = 0; page < 5; page++) {                  // 1,000 entries; the current values are applied anyway
      const d = await this.request("GET", `/${MODULE[kind]}/${id}/__timeline${token ? `?page_token=${encodeURIComponent(token)}` : ""}`);
      if (d.status === 204) break;
      if (!Array.isArray(d.data?.__timeline)) throw new CrmError(502, "Zoho timeline returned no list");
      for (const e of d.data.__timeline) {
        if (e.record?.id && String(e.record.id) !== id) continue;
        const at = Date.parse(e.audited_time);
        if (!Number.isFinite(at)) continue;
        for (const h of e.field_history ?? []) if (this.theirs[kind].includes(h.api_name)) out.push({ field: h.api_name, value: str(h._value?.new), at });
      }
      token = d.data.info?.more_records ? d.data.info.next_page_token ?? "" : "";
      if (!token) break;
    }
    return out;
  }

  /** Zoho's channels last a week at most. They only say that something changed; polling fetches what. */
  async renewNotifications() {
    const url = this.o.notifyUrl, token = this.o.tokens.connection().hook_secret;
    if (!url?.startsWith("https://") || !token) return;
    if (Number(this.o.state.get("watch_until")) > Date.now() + 86_400_000 && this.o.state.get("watch_url") === url) return;
    let base = this.o.state.get("watch_channel");
    if (!base) this.o.state.set("watch_channel", (base = String(randomInt(1_000_000, 2_000_000_000) * 10)));
    const until = Date.now() + 6.5 * 86_400_000;
    const watch = KINDS.map((k, n) => ({ channel_id: String(Number(base) + n), events: [`${MODULE[k]}.all`], channel_expiry: iso(until), token, notify_url: url }));
    const { data } = await this.request("POST", "/actions/watch", { body: { watch } });
    if (!Array.isArray(data?.watch) || data.watch.some((w: any) => w.code !== "SUCCESS")) throw new CrmError(502, "Zoho did not accept the notification channels");
    this.o.state.set("watch_until", String(until));
    this.o.state.set("watch_url", url);
  }
}
