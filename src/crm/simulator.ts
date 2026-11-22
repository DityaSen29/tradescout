import type { Kind, Props } from "./adapter.js";

/**
 * An in-memory stand-in for the HubSpot endpoints the adapter uses, for tests and the offline demo.
 * The real adapter runs against it. It is not proof that HubSpot accepts these requests.
 */
const KIND: Record<string, Kind> = { companies: "company", contacts: "contact", deals: "deal" };
const ID = "meridian_lead_id";
interface Row { id: string; props: Props; history: Record<string, { value: string; timestamp: string }[]> }

export class HubSpotSimulator {
  rows: Record<Kind, Map<string, Row>> = { company: new Map(), contact: new Map(), deal: new Map() };
  merged = new Map<string, string>();
  requests: { method: string; path: string; body: any }[] = [];
  /** Queue of failures for the next requests that match. `after` means HubSpot did the write, then the answer was lost. */
  fail: { match: RegExp; status: number; after?: boolean }[] = [];
  portal = 999001;
  private schema = new Map<string, boolean>();
  private next = 100;
  private clock = 0;

  private tick() { return new Date((this.clock = Math.max(Date.now(), this.clock + 1))).toISOString(); }
  private out = (r: Row) => ({ id: r.id, properties: { ...r.props }, propertiesWithHistory: structuredClone(r.history) });
  count(kind: Kind) { return this.rows[kind].size; }
  seed(kind: Kind, props: Props): Row {
    const row: Row = { id: String(this.next++), props: {}, history: {} };
    this.rows[kind].set(row.id, row);
    this.set(kind, row.id, props);
    return row;
  }
  set(kind: Kind, id: string, props: Props) {
    const row = this.rows[kind].get(id)!;
    for (const [field, value] of Object.entries(props)) { row.props[field] = value; (row.history[field] ??= []).unshift({ value, timestamp: this.tick() }); }
  }
  remove(kind: Kind, id: string) { this.rows[kind].delete(id); }
  merge(kind: Kind, loser: string, winner: string) {
    this.rows[kind].delete(loser);
    this.merged.set(`${kind}:${loser}`, winner);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const line = `${method} ${url.pathname}`;
    this.requests.push({ method, path: url.pathname, body });
    const i = this.fail.findIndex(f => f.match.test(line)), fault = i >= 0 ? this.fail.splice(i, 1)[0] : null;
    if (fault && !fault.after) return Response.json({ message: "injected failure" }, { status: fault.status });
    const res = this.answer(method, url, body);
    return fault ? Response.json({ message: "answer lost" }, { status: fault.status }) : res;
  };

  private answer(method: string, url: URL, body: any): Response {
    const p = url.pathname.split("/").filter(Boolean), gone = () => Response.json({ message: "not found" }, { status: 404 });
    if (p[0] === "account-info") return Response.json({ portalId: this.portal });
    if (p[2] === "pipelines") return Response.json({ results: [{ id: "default", displayOrder: 0, stages: ["appointmentscheduled", "qualifiedtobuy", "closedwon"].map((id, displayOrder) => ({ id, displayOrder })) }] });
    if (p[2] === "properties") {
      const key = `${p[3]}/${p[4] ?? body?.name}`;
      if (method === "POST") { this.schema.set(key, !!body.hasUniqueValue); return Response.json(body, { status: 201 }); }
      return this.schema.has(key) ? Response.json({ name: p[4], hasUniqueValue: this.schema.get(key) }) : gone();
    }
    const kind = KIND[p[3]];
    if (p[2] !== "objects" || !kind) return gone();
    const rows = this.rows[kind];
    if (p[5] === "associations") return rows.has(p[4]) ? Response.json({ status: "COMPLETE" }) : gone();
    if (p[4] === "search") {
      const f = body.filterGroups[0].filters[0];
      return Response.json({ results: [...rows.values()].filter(r => r.props[f.propertyName] === f.value).map(this.out) });
    }
    if (p[4] === "batch") return Response.json({ results: body.inputs.flatMap((x: any) => (rows.has(x.id) ? [this.out(rows.get(x.id)!)] : [])) });
    if (method === "POST") {
      for (const k of [ID, ...(kind === "contact" ? ["email"] : [])])
        if (body.properties[k] && [...rows.values()].some(r => r.props[k] === body.properties[k])) return Response.json({ message: `${k} already exists` }, { status: 409 });
      return Response.json(this.out(this.seed(kind, body.properties)), { status: 201 });
    }
    const id = decodeURIComponent(p[4] ?? "");
    const row = url.searchParams.get("idProperty") === ID ? [...rows.values()].find(r => r.props[ID] === id) : rows.get(this.merged.get(`${kind}:${id}`) ?? id);
    if (!row) return gone();
    if (method === "PATCH") this.set(kind, row.id, body.properties);
    return Response.json(this.out(row));
  }
}
