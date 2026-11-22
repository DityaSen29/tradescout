/**
 * Crustdata REST client (API version 2025-11-01). Plain fetch, no SDK.
 * Every response's x-credits-used header is returned so the ledger can record the exact charge.
 * 429 → wait x-ratelimit-reset (or backoff) and retry; 402/403 → clear errors, no retry.
 */
export const CRUSTDATA_BASE = "https://api.crustdata.com";
export const CRUSTDATA_VERSION = "2025-11-01";

export interface CrustResponse<T = any> { data: T; credits: number; ratelimit_remaining: number | null; retrieved_at: string; status: number }
export class CrustdataError extends Error { constructor(public status: number, msg: string) { super(msg); this.name = "CrustdataError"; } }

export type Filter = { field: string; type: string; value: unknown } | { op: "and" | "or"; conditions: Filter[] };
export const f = (field: string, type: string, value: unknown): Filter => {
  if (type === ">=" || type === "<=") throw new Error("Crustdata uses => and =<, not >= and <=");
  return { field, type, value };
};
export const and = (...c: Filter[]): Filter => ({ op: "and", conditions: c });
export const or = (...c: Filter[]): Filter => ({ op: "or", conditions: c });

export class Crustdata {
  constructor(private key = process.env.CRUSTDATA_API_KEY ?? "", private maxTries = 4) {
    if (!this.key) throw new CrustdataError(401, "CRUSTDATA_API_KEY is not set");
  }
  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<CrustResponse<T>> {
    for (let attempt = 0; attempt < this.maxTries; attempt++) {
      const res = await fetch(CRUSTDATA_BASE + path, {
        method, headers: { authorization: `Bearer ${this.key}`, "x-api-version": CRUSTDATA_VERSION, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) {
        const wait = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? 2 ** attempt);
        await new Promise(r => setTimeout(r, Math.min(30, wait) * 1000 + Math.random() * 800));
        continue;
      }
      if (res.status === 402) throw new CrustdataError(402, "credits exhausted (402); check GET /account/credits");
      if (res.status === 403) throw new CrustdataError(403, `${path} is not enabled on this key (403)`);
      if (res.status === 401) throw new CrustdataError(401, "key rejected (401)");
      if (res.status >= 500 && attempt < this.maxTries - 1) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      const text = await res.text();
      if (res.status >= 400) throw new CrustdataError(res.status, `${res.status} ${path}: ${text.slice(0, 300)}`);
      const data = text ? JSON.parse(text) : {};
      return { data, credits: Number(res.headers.get("x-credits-used") ?? 0), ratelimit_remaining: res.headers.get("x-ratelimit-remaining") ? Number(res.headers.get("x-ratelimit-remaining")) : null, retrieved_at: new Date().toISOString(), status: res.status };
    }
    throw new CrustdataError(429, `rate limited after ${this.maxTries} tries on ${path}`);
  }
  endpoints() { return this.request("GET", "/account/endpoints"); }
  credits() { return this.request("GET", "/account/credits"); }
  companySearch(p: { filters?: Filter; fields: string[]; limit?: number; query?: string; mode?: "hybrid" | "lexical" | "semantic"; cursor?: string }) {
    const body: any = { fields: p.fields, limit: p.limit ?? 25 };
    if (p.filters) body.filters = p.filters;
    if (p.query) body.search = { query: p.query, mode: p.mode ?? "hybrid" };
    if (p.cursor) body.cursor = p.cursor;
    return this.request("POST", "/company/search", body);
  }
  companyEnrich(p: { domains?: string[]; ids?: number[]; fields?: string[]; exact_match?: boolean }) {
    const body: any = { fields: p.fields ?? ["basic_info", "headcount", "funding", "news"], exact_match: p.exact_match ?? true };
    if (p.domains) body.domains = p.domains.slice(0, 25);
    if (p.ids) body.crustdata_company_ids = p.ids.slice(0, 25);
    return this.request("POST", "/company/enrich", body);
  }
  companyIdentify(p: { name?: string; domain?: string; domains?: string[] }) {
    const body: any = {};
    if (p.domains) body.domains = p.domains; else if (p.domain) body.domains = [p.domain];
    if (p.name) body.name = p.name;
    return this.request("POST", "/company/identify", body);
  }
  companyAutocomplete(field: string, query: string) { return this.request("POST", "/company/autocomplete", { field, query }); }
  personSearch(p: { filters: Filter; fields: string[]; limit?: number; query?: string }) {
    const body: any = { filters: p.filters, fields: p.fields, limit: p.limit ?? 10 };
    if (p.query) body.search = { query: p.query };
    return this.request("POST", "/person/search", body);
  }
  jobSearch(p: { filters: Filter; fields?: string[]; limit?: number; aggregations?: unknown }) {
    const body: any = { filters: p.filters, limit: p.limit ?? 0 };
    if (p.fields) body.fields = p.fields;
    if (p.aggregations) body.aggregations = p.aggregations;
    return this.request("POST", "/job/search", body);
  }
  webSearch(p: { query: string; sources?: string[]; page?: number }) {
    return this.request("POST", "/web/search/live", { query: p.query, sources: p.sources ?? ["news", "web"], page: p.page ?? 1 });
  }
}

const get = (d: any, path: string) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), d);
/** Flatten a company record from search or enrich into the shape scoring expects. */
export function flattenCompany(c: any) {
  const industries: string[] = [get(c, "taxonomy.professional_network_industries"), get(c, "basic_info.industries"), get(c, "taxonomy.professional_network_industry")].flat().filter(Boolean);
  return {
    company_id: String(c.crustdata_company_id ?? get(c, "basic_info.company_id") ?? ""),
    name: get(c, "basic_info.name") ?? null,
    domain: get(c, "basic_info.primary_domain") ?? null,
    website: get(c, "basic_info.website") ?? null,
    description: get(c, "basic_info.description") ?? null,
    year_founded: toNum(get(c, "basic_info.year_founded")),
    linkedin: get(c, "basic_info.professional_network_url") ?? null,
    country: get(c, "locations.country") ?? get(c, "locations.headquarters.country") ?? null,
    city: get(c, "locations.city") ?? get(c, "locations.headquarters.city") ?? null,
    headcount: toNum(get(c, "headcount.total")),
    growth_6m: toNum(get(c, "headcount.growth_percent.6m")),
    growth_12m: toNum(get(c, "headcount.growth_percent.12m")),
    funding_usd: toNum(get(c, "funding.total_investment_usd")),
    last_round_type: get(c, "funding.last_round_type") ?? null,
    industries: [...new Set(industries.map(String))],
    news: (c.news ?? []) as any[],
    competitors: (get(c, "competitors.company_ids") ?? []) as number[],
  };
}
export function flattenPerson(p: any) {
  return {
    person_id: String(p.crustdata_person_id ?? ""),
    name: get(p, "basic_profile.name") ?? null,
    headline: get(p, "basic_profile.headline") ?? null,
    title: get(p, "experience.employment_details.current.title") ?? get(p, "basic_profile.current_title") ?? null,
    company: get(p, "experience.employment_details.current.company_name") ?? null,
    company_id: get(p, "experience.employment_details.current.company_id") ?? null,
    country: get(p, "basic_profile.location.country") ?? null,
    linkedin: get(p, "basic_info.professional_network_url") ?? get(p, "basic_profile.professional_network_url") ?? null,
  };
}
const toNum = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
