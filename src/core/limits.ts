/**
 * Hard API limits. Set by the operator through the environment, never by a request or a model.
 * Units: crustdata and apollo are provider credits, llm is USD.
 * The gate covers calls made through ctx.call. Calls made outside this app are not counted.
 */
export const PAID_PROVIDERS = ["crustdata", "apollo", "llm"] as const;
export type PaidProvider = (typeof PAID_PROVIDERS)[number];
const FREE_SOURCES = new Set(["comtrade", "wits"]);

const SETTINGS: Record<PaidProvider, { run: [string, number]; day: [string, number] }> = {
  crustdata: { run: ["RUN_CREDIT_LIMIT", 150], day: ["CRUSTDATA_DAILY_LIMIT", 1500] },
  apollo: { run: ["APOLLO_RUN_LIMIT", 25], day: ["APOLLO_DAILY_LIMIT", 100] },
  llm: { run: ["LLM_RUN_LIMIT_USD", 0.5], day: ["LLM_DAILY_LIMIT_USD", 3] },
};

/** A malformed limit is an error, never "unlimited". */
export function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more, got "${raw}"`);
  return n;
}
export const limitFor = (p: PaidProvider, scope: "run" | "day") => envLimit(...SETTINGS[p][scope]);

/** null means free. A source nobody has classified is refused. */
export function paidProvider(source: string): PaidProvider | null {
  if (FREE_SOURCES.has(source)) return null;
  if ((PAID_PROVIDERS as readonly string[]).includes(source)) return source as PaidProvider;
  throw new Error(`no API limit is defined for source "${source}"; add it to src/core/limits.ts`);
}

/** The budget day turns over at midnight IST. */
export const budgetDay = (at = new Date()) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Worst-case credits per call, from GET /account/endpoints on 22 Nov 2026.
 * A premium field group is billed once as a filter and again as a returned field.
 */
export const MAX_CREDITS = {
  companySearch: (limit: number) => limit * (0.03 + 0.2 + 0.2 + 0.1), // base, headcount filter, headcount field, taxonomy field
  companyEnrich: (count: number) => count * 2,
  personSearch: (limit: number) => limit * (0.03 + 0.1 + 0.1),        // base, experience filter, experience field
  personEnrichWorkEmail: (count: number) => count * 2,                 // base 1 + contact.business_emails 1
  jobSearch: (limit: number) => limit * 0.03,
  webSearch: (pages: number) => pages,
};
