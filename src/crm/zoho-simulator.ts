import type { Kind, Props } from "./adapter.js";

/**
 * An in-memory stand-in for the Zoho CRM v8 and sign-in endpoints the adapter uses, following Zoho's docs.
 * Search is missing on purpose: it lags in real Zoho, and the adapter must never use it.
 * It is not proof that Zoho accepts these requests.
 */
const KIND: Record<string, Kind> = { Accounts: "company", Contacts: "contact", Deals: "deal" };
const CUSTOM: Record<string, string> = { "Meridian Lead Id": "Meridian_Lead_Id", "Meridian Match": "Meridian_Match", "Meridian Status": "Meridian_Status" };
const ID = "Meridian_Lead_Id";
const LOOKUPS = ["Account_Name", "Contact_Name"];
interface Row { id: string; props: Record<string, any>; modified: string; timeline: any[] }

export class ZohoSimulator {
  rows: Record<Kind, Map<string, Row>> = { company: new Map(), contact: new Map(), deal: new Map() };
  fields: Record<Kind, Map<string, any>> = { company: new Map(), contact: new Map(), deal: new Map() };
  requests: { method: string; path: string; query: URLSearchParams; body: any; headers: Record<string, string> }[] = [];
  fail: { match: RegExp; status: number; after?: boolean; code?: string; run?: () => void }[] = [];
  watches: any[] = [];
  org = "5725767000000020005";
  token = "";
  issued = 0;
  closingRequired = true;
  /** An account name that a validation rule refuses. */
  refuse = "";
  pageSize = 200;
  private next = 5725767000001000000n;
  private clock = 0;

  constructor(readonly edition: "free" | "enterprise" = "enterprise") {}

  private tick(): string {
    // Zoho's times have whole seconds
    this.clock = Math.max(Math.floor(Date.now() / 1000), this.clock + 1);
    return new Date(this.clock * 1000).toISOString().replace(".000Z", "+00:00");
  }
  count(kind: Kind) { return this.rows[kind].size; }
  seed(kind: Kind, props: Props | Record<string, any>): Row {
    const row: Row = { id: String(this.next++), props: { Owner: { id: "9001", name: "Demo Owner" } }, modified: "", timeline: [] };
    this.rows[kind].set(row.id, row);
    this.set(kind, row.id, props);
    return row;
  }
  set(kind: Kind, id: string, props: Record<string, any>) {
    const row = this.rows[kind].get(id)!, at = this.tick(), field_history = [];
    for (const [api_name, value] of Object.entries(props)) {
      if (api_name === "id") continue;
      field_history.push({ api_name, _value: { old: row.props[api_name] ?? null, new: value && typeof value === "object" ? value.name ?? value.id : value } });
      row.props[api_name] = value;
    }
    row.modified = at;
    row.timeline.unshift({ id: String(this.next++), record: { id }, audited_time: at, action: "updated", field_history });
  }
  remove(kind: Kind, id: string) { this.rows[kind].delete(id); }
  merge(kind: Kind, loser: string, _winner: string) { this.rows[kind].delete(loser); }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", raw = String(init?.body ?? "");
    const form = url.pathname === "/oauth/v2/token", headers = (init?.headers ?? {}) as Record<string, string>;
    const body = !raw ? undefined : form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    const line = `${method} ${url.pathname}`;
    this.requests.push({ method, path: url.pathname, query: url.searchParams, body, headers });
    const i = this.fail.findIndex(f => f.match.test(line)), fault = i >= 0 ? this.fail.splice(i, 1)[0] : null;
    fault?.run?.();
    const failed = () => Response.json({ code: fault!.code ?? "INTERNAL_ERROR", message: "injected failure" }, { status: fault!.status });
    if (fault?.status && !fault.after) return failed();
    const res = form ? this.oauth(body) : this.answer(method, url, body, headers);
    return fault?.status ? failed() : res;
  };

  private oauth(body: any): Response {
    if (!body.client_id || !body.client_secret || !(body.refresh_token || body.code)) return Response.json({ error: "invalid_client" });
    this.token = `access-${++this.issued}`;
    return Response.json({ access_token: this.token, expires_in: 3600, api_domain: "https://www.zohoapis.in", ...(body.code ? { refresh_token: "refresh-1" } : {}) });
  }

  private answer(method: string, url: URL, body: any, headers: Record<string, string>): Response {
    const none = () => new Response(null, { status: 204 });
    const bad = (code: string, message = code, status = 400) => Response.json({ code, message, status: "error" }, { status });
    if (!this.token || headers.authorization !== `Zoho-oauthtoken ${this.token}`) return bad("INVALID_TOKEN", "invalid oauth token", 401);
    const p = url.pathname.split("/").filter(Boolean).slice(2), q = url.searchParams, free = this.edition === "free";
    if (p[0] === "org") return Response.json({ org: [{ id: this.org, type: "production", license_details: { paid: !free, paid_type: this.edition, trial_type: null } }] });
    if (p[0] === "actions") { this.watches.push(...body.watch); return Response.json({ watch: body.watch.map(() => ({ code: "SUCCESS" })) }); }
    if (p[0] === "coql") return this.coql(body.select_query);

    if (p[0] === "settings") {
      if (p[1] === "layouts")
        return Response.json({ layouts: [{ id: "77", name: "Standard", status: "active", sections: [{ fields: [{ api_name: "Stage", pick_list_values: [] }, { api_name: "Pipeline" }, { api_name: "Closing_Date", required: this.closingRequired }] }] }] });
      if (p[1] === "pipeline")
        return Response.json({ pipeline: [{ actual_value: "Standard (Standard)", default: true, maps: ["Qualification", "Needs Analysis", "Closed Won"].map((actual_value, i) => ({ actual_value, sequence_number: i + 1 })) }] });
      const kind = KIND[q.get("module")!];
      if (method === "POST") {
        if (free) return bad("NOT_SUPPORTED", "custom fields are not available in this edition", 403);
        for (const f of body.fields) this.fields[kind].set(CUSTOM[f.field_label], { api_name: CUSTOM[f.field_label], unique: f.unique ?? {} });
        return Response.json({ fields: body.fields.map(() => ({ code: "SUCCESS" })) });
      }
      return Response.json({ fields: [{ api_name: "Owner", unique: {} }, ...this.fields[kind].values()] });
    }

    const kind = KIND[p[0]];
    if (!kind) return bad("INVALID_MODULE");
    const rows = this.rows[kind];
    if (p[1] === "search") throw new Error("the adapter must not use Zoho search");
    if (p[2] === "__timeline") return rows.has(p[1]) ? Response.json({ __timeline: rows.get(p[1])!.timeline, info: { more_records: false } }) : none();
    const shown = (r: Row, fields?: string[]) => ({
      id: r.id, Modified_Time: r.modified,
      ...Object.fromEntries((fields ?? Object.keys(r.props)).filter(f => f !== "Modified_Time").map(f => {
        const v = r.props[f] ?? null;
        return [f, v && LOOKUPS.includes(f) && typeof v === "object" ? { id: v.id, name: `record ${v.id}` } : v];
      })),
    });

    if (method === "GET") {
      if (p[1]) return rows.has(p[1]) ? Response.json({ data: [shown(rows.get(p[1])!)] }) : none();
      const fields = q.get("fields")?.split(",");
      if (!fields) return bad("REQUIRED_PARAM_MISSING");
      let list = q.get("ids") ? q.get("ids")!.split(",").flatMap(id => rows.get(id) ?? []) : [...rows.values()];
      const from = Number(q.get("page_token") ?? 0), more = list.length > from + this.pageSize;
      list = list.slice(from, from + this.pageSize);
      return list.length ? Response.json({ data: list.map(r => shown(r, fields)), info: { more_records: more, next_page_token: more ? String(from + this.pageSize) : null } }) : none();
    }
    if (method !== "POST" && method !== "PUT") return bad("INVALID_REQUEST_METHOD");

    const out = body.data.map((item: any) => {
      const error = (code: string, api_name?: string) => ({ code, message: code, status: "error", details: { api_name } });
      const row = method === "PUT" ? rows.get(item.id) : undefined;
      if (method === "PUT" && !row) return error("INVALID_DATA", "id");
      for (const f of Object.values(CUSTOM)) if (f in item && !this.fields[kind].has(f)) return error("INVALID_DATA", f);
      for (const f of Object.keys(item)) if (f === "Closing_Date" && kind !== "deal") return error("INVALID_DATA", f);
      if (item[ID] && [...rows.values()].some(r => r.id !== row?.id && r.props[ID]?.toLowerCase() === item[ID].toLowerCase())) return error("DUPLICATE_DATA", ID);
      const since = headers["If-Unmodified-Since"];
      if (row && since && Date.parse(row.modified) > Date.parse(since)) return error("ALREADY_MODIFIED");
      const merged = { ...row?.props, ...item };
      const must = kind === "company" ? ["Account_Name"] : kind === "contact" ? ["Last_Name"] : ["Deal_Name", "Stage", "Pipeline", ...(this.closingRequired ? ["Closing_Date"] : [])];
      if (this.refuse && merged.Account_Name === this.refuse) return error("INVALID_DATA", "Account_Name");
      for (const f of must) if (!merged[f]) return error("MANDATORY_NOT_FOUND", f);
      let id: string;
      if (row) { this.set(kind, row.id, item); id = row.id; } else id = this.seed(kind, item).id;
      return { code: "SUCCESS", status: "success", details: { id } };
    });
    const errors = out.filter((r: any) => r.code !== "SUCCESS").length;
    return Response.json({ data: out }, { status: !errors ? (method === "POST" ? 201 : 200) : errors === out.length ? 400 : 207 });
  }

  private coql(query: string): Response {
    const m = query.match(/^select id from (\w+) where (.+) limit (\d+)$/);
    if (!m) return Response.json({ code: "SYNTAX_ERROR", message: query }, { status: 400 });
    const kind = KIND[m[1]], text = (v: string) => v.replace(/\\(['\\])/g, "$1");
    const value = "'((?:\\\\.|[^'\\\\])*)'";
    const tests: ((r: Row) => boolean)[] = [];
    const unknown = (f: string) => Object.values(CUSTOM).includes(f) && !this.fields[kind].has(f);
    let refused = false, rest = m[2].replace(new RegExp(`(\\w+) in \\(((?:${value},?)+)\\)`, "g"), (_all, f: string, list: string) => {
      refused ||= unknown(f) || f === "Description";
      const values = [...list.matchAll(new RegExp(value, "g"))].map(x => text(x[1]).toLowerCase());
      tests.push(r => values.includes(String(r.props[f] ?? "").toLowerCase()));
      return "";
    });
    rest = rest.replace(new RegExp(`(\\w+) (=|like) ${value}`, "g"), (_all, f: string, op: string, v: string) => {
      refused ||= unknown(f) || f === "Description";
      const want = text(v).toLowerCase();
      tests.push(r => { const has = String(r.props[f] ?? "").toLowerCase(); return op === "=" ? has === want : has.includes(want.replace(/%/g, "")); });
      return "";
    });
    if (refused || !tests.length || rest.replace(/\(|\)|\bor\b|\s/g, "")) return Response.json({ code: "INVALID_QUERY", message: query }, { status: 400 });
    const hit = [...this.rows[kind].values()].filter(r => tests.some(t => t(r))).map(r => ({ id: r.id }));
    if (!hit.length) return new Response(null, { status: 204 });
    return Response.json({ data: hit.slice(0, Number(m[3])), info: { more_records: hit.length > Number(m[3]) } });
  }
}
