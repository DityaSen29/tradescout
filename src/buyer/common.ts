import type { StepCtx } from "../runner/pipeline.js";
import { hashOf } from "../ledger/ledger.js";
import { cleanName, tokenSetRatio } from "../sources/sanctions.js";
import type { Claim, Lead, MatchLabel } from "./contract.js";

export interface Trace { agent: string; message: string; at: string }
/** Every reasoning line an agent shows: streamed live, and kept in the step output for replay. */
export function tracer(ctx: StepCtx) {
  const trace: Trace[] = [];
  const say = (agent: string, message: string) => { trace.push({ agent, message, at: new Date().toISOString() }); ctx.log(`agent:${agent}: ${message}`); };
  return { trace, say };
}

export const clientId = (ctx: StepCtx) => ctx.request.client_id ?? "default";
/** Same company, same client, same market, same id: in every run and on either route. */
export const leadId = (client: string, iso3: string, name: string) => hashOf([client, iso3, cleanName(name) || name.trim().toLowerCase()]).slice(0, 16);

export const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** The first check on any claim is code: are the quoted words really in the source? */
export function quoteInSource(quote: string, source: string): boolean {
  const q = squash(quote);
  return q.length >= 8 && squash(source).includes(q);
}
export const hostOf = (url: string | null) => { try { return new URL(url!).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
/** A web page may speak for a company only if it is the company's own site or names the company. */
export function sourceAboutCompany(src: { url: string | null; text: string }, company: { name: string; domain: string | null }): boolean {
  const host = hostOf(src.url), dom = company.domain?.replace(/^www\./, "").toLowerCase();
  if (host && dom && (host === dom || host.endsWith(`.${dom}`))) return true;
  const name = cleanName(company.name);
  if (name.length >= 5 && ` ${cleanName(src.text)} `.includes(` ${name} `)) return true;
  // pages write "Alkun Steel" for "Al Kun Steel trd", and search links can be redirects
  const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const body = flat(src.text), short = flat(company.name.replace(/\b(trading|trd|est|establishment|llc|l\.l\.c\.?|fze|fzc|fzco|co|company|ltd|limited|international|group|inc)\b\.?/gi, " "));
  const label = flat(dom?.split(".")[0] ?? "");
  return (short.length >= 8 && body.includes(short)) || (label.length >= 8 && body.includes(label));
}
export const sameCompany = (a: string, b: string) => tokenSetRatio(a, b) >= 80;

export function newLead(ctx: StepCtx, p: { name: string; domain?: string | null; iso3: string; id?: string | null; hs: string[]; match: MatchLabel; reason: string; score: number; claims?: Claim[] }): Lead {
  const client = clientId(ctx);
  return { lead_id: leadId(client, p.iso3, p.name), client_id: client, run_id: ctx.runId,
    company: { name: p.name, domain: p.domain ?? null, country_iso3: p.iso3, crustdata_company_id: p.id ?? null },
    product: ctx.request.product, hs_codes: p.hs, match: p.match, match_reason: p.reason, fit_score: p.score,
    behaviour: null, claims: p.claims ?? [], contact: null, selected: false, needs_person: [] };
}
