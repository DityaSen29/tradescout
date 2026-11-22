import { Resolver } from "node:dns/promises";
import { budgetDay } from "../core/limits.js";
import { DAY_MS } from "./config.js";
import type { Call } from "./io.js";

export type Level = "ok" | "warn" | "fail" | "unknown";
export interface Check { level: Level; summary: string; fix: string | null; record: string | null }
export interface DomainHealth { domain: string; checked_at: string; spf: Check; dkim: Check; dmarc: Check; selector: string | null }

/** Records, or [] when DNS says there are none. Any other failure throws: unknown is never reported as missing. */
export type TxtLookup = (name: string) => Promise<string[]>;
export function txtLookup(): TxtLookup {
  const own = new Resolver({ timeout: 3000, tries: 2 });
  // some networks' resolvers refuse large TXT answers; ask a public one before calling it unknown
  const open = new Resolver({ timeout: 3000, tries: 2 });
  open.setServers(["1.1.1.1", "8.8.8.8"]);
  return async name => {
    let failed: unknown;
    for (const resolver of [own, open]) {
      try { return (await resolver.resolveTxt(name)).map(parts => parts.join("")); }
      catch (err: any) {
        if (err?.code === "ENODATA" || err?.code === "ENOTFOUND") return [];
        failed = err;
      }
    }
    throw failed;
  };
}
const SELECTORS = ["google", "default", "20251104", "20230601", "selector1", "selector2", "mail", "dkim", "k1", "s1", "s2", "smtp", "gmail", "googleworkspace"];
const ok = (summary: string, record: string | null): Check => ({ level: "ok", summary, fix: null, record });
const bad = (level: Level, summary: string, fix: string, record: string | null = null): Check => ({ level, summary, fix, record });

async function spf(domain: string, txt: TxtLookup): Promise<Check> {
  const own = (await txt(domain)).filter(r => /^v=spf1(\s|$)/i.test(r));
  if (!own.length) return bad("fail", "This domain doesn't say who may send for it, so inboxes are likely to distrust its mail.", `Add a TXT record on ${domain}: v=spf1 include:_spf.google.com ~all`);
  if (own.length > 1) return bad("fail", "There are two or more SPF records. Receivers treat that as broken and ignore them all.", "Merge them into one v=spf1 record.", own.join(" | "));
  const record = own[0];
  if (/(^|\s)\+?all(\s|$)/i.test(record)) return bad("fail", "SPF lets anyone on the internet send as this domain.", "Change +all to ~all.", record);

  let lookups = 0, google = false, softEnd = /(^|\s)[~-]all(\s|$)/i.test(record);
  const walk = async (rec: string, depth: number): Promise<void> => {
    for (const term of rec.split(/\s+/).slice(1)) {
      const m = /^[+?~-]?(include:|redirect=)(\S+)$/i.exec(term);
      if (m) {
        if (++lookups > 10 || depth > 10) return;
        const target = m[2].toLowerCase().replace(/\.$/, "");
        if (target === "_spf.google.com") google = true;
        const child = (await txt(target)).find(r => /^v=spf1(\s|$)/i.test(r));
        if (!child) continue;
        if (m[1].toLowerCase() === "redirect=" && /(^|\s)[~-]all(\s|$)/i.test(child)) softEnd = true;
        await walk(child, depth + 1);
      } else if (/^[+?~-]?(a|mx|ptr|exists:)([:/]|$)/i.test(term) || /^[+?~-]?exists:/i.test(term)) lookups++;
    }
  };
  await walk(record, 0);
  if (lookups > 10) return bad("fail", "SPF needs more than 10 DNS lookups, the limit, so receivers will reject the record.", "Remove includes for tools you no longer use.", record);
  if (!google) return bad("warn", "SPF exists but doesn't name Google, so mail sent through Gmail may fail this check.", "Add include:_spf.google.com before the final all.", record);
  if (!softEnd) return bad("warn", "SPF names Google but doesn't tell receivers what to do with other senders.", "End the record with ~all.", record);
  return ok("Gmail is allowed to send for this domain.", record);
}

async function dkim(domain: string, txt: TxtLookup, chosen: string | null): Promise<{ check: Check; selector: string | null }> {
  const names = chosen ? [chosen] : SELECTORS;
  const found = await Promise.all(names.map(async selector => {
    try { return { selector, record: (await txt(`${selector}._domainkey.${domain}`)).find(r => /(^|;)\s*p=/i.test(r)) ?? null, failed: false }; }
    catch { return { selector, record: null, failed: true }; }
  }));
  const good = found.find(f => f.record && /(^|;)\s*p=\s*[A-Za-z0-9+/]/i.test(f.record));
  if (good) return { selector: good.selector, check: ok(`A DKIM key is published (${good.selector}). A test email's headers confirm Gmail signs with it.`, good.record!.slice(0, 80)) };
  if (chosen && found.some(f => f.record)) return { selector: null, check: bad("fail", "The DKIM key is published empty, which means it was revoked.", "Generate a new key in Google Admin and publish it.") };
  if (found.some(f => f.failed)) return { selector: null, check: bad("unknown", "DKIM couldn't be looked up just now.", "Run the check again.") };
  if (chosen) return { selector: null, check: bad("fail", `There is no DKIM key at "${chosen}".`, "Publish the key shown in Google Admin > Apps > Gmail > Authenticate email.") };
  // an old selector revoked on rotation says nothing about the one in use
  return { selector: null, check: bad("warn", "No live DKIM key found under the usual names. It may use another name, or Gmail may not be signing.", "In Google Admin > Apps > Gmail > Authenticate email, turn on signing, then enter its selector here.") };
}

async function dmarc(domain: string, txt: TxtLookup): Promise<Check> {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const at = labels.slice(i).join(".");
    const rows = (await txt(`_dmarc.${at}`)).filter(r => /^v=DMARC1\s*(;|$)/i.test(r));
    if (!rows.length) continue;
    if (rows.length > 1) return bad("fail", "There are several DMARC records, so receivers ignore them.", `Keep one record at _dmarc.${at}.`, rows.join(" | "));
    const tags = Object.fromEntries(rows[0].split(";").map(t => t.split("=").map(x => x.trim().toLowerCase())).filter(t => t.length === 2));
    const policy = i ? (tags.sp ?? tags.p) : tags.p;
    if (policy === "reject" || policy === "quarantine") return ok(`DMARC protects this domain (${policy}${i ? `, inherited from ${at}` : ""}).`, rows[0]);
    if (policy === "none") return bad("warn", "DMARC is only watching. Forged mail in this name is not blocked.", "Once reports look clean, move p=none to p=quarantine.", rows[0]);
    return bad("fail", "The DMARC record has no valid policy.", "Set p=none to start, with a rua address for reports.", rows[0]);
  }
  return bad("fail", "There is no DMARC record. Gmail requires one from bulk senders and trusts mail less without it.", `Add a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${domain}`);
}

export async function checkDomain(input: string, opts: { txt?: TxtLookup; selector?: string | null; call?: Call } = {}): Promise<DomainHealth> {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) throw new Error("That isn't a domain name.");
  const selector = opts.selector?.trim().toLowerCase() || null;
  if (selector && !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(selector)) throw new Error("That isn't a DKIM selector.");
  const base = opts.txt ?? txtLookup();
  const txt: TxtLookup = opts.call ? async name => (await opts.call!({ source: "dns", endpoint: "TXT", request: { name }, cacheable: false }, () => base(name))).data : base;
  const unknown = (what: string) => () => bad("unknown", `${what} couldn't be looked up, so it is not counted as healthy.`, "Run the check again.");
  const [s, d, m] = await Promise.all([spf(domain, txt).catch(unknown("SPF")), dkim(domain, txt, selector), dmarc(domain, txt).catch(unknown("DMARC"))]);
  return { domain, checked_at: new Date().toISOString(), spf: s, dkim: d.check, dmarc: m, selector: d.selector };
}

export interface CapInput { health: DomainHealth | null; firstSend: number | null; now: number; sentToday: number; manual: number | null; ceiling: number; bounces: number; recentSends: number }
export interface Cap { limit: number; used: number; left: number; week: number; reason: string }

/** 10, 20, 30, then 40 a day by week of sending, cut by domain health and by bounces. */
export function dailyCap(i: CapInput): Cap {
  const week = i.firstSend === null ? 1 : Math.max(1, Math.floor((i.now - i.firstSend) / (7 * DAY_MS)) + 1);
  let limit = [10, 20, 30, 40][Math.min(week, 4) - 1];
  let reason = `Week ${week} of the ramp.`;
  const h = i.health;
  if (!h) { limit = 0; reason = "Sending waits for the first domain check."; }
  else if (h.spf.level === "fail" || h.spf.level === "unknown") { limit = 0; reason = "Sending is paused until SPF passes."; }
  else if (h.dmarc.level === "unknown" || h.dkim.level === "unknown") { limit = 0; reason = "Sending is paused until the DNS check completes."; }
  else if (h.dmarc.level === "fail" || h.dkim.level === "fail") { limit = Math.min(5, limit); reason += " Held at 5 until DKIM and DMARC are fixed."; }
  else if ([h.spf, h.dkim, h.dmarc].some(c => c.level === "warn")) { limit = Math.ceil(limit / 2); reason += " Halved while a domain warning is open."; }
  if (i.bounces >= 3 && i.bounces / Math.max(1, i.recentSends) > 0.03) { limit = 0; reason = "Paused: over 3% of the last 7 days' mail bounced."; }
  const hard = Math.min(i.ceiling, i.manual ?? Infinity);
  if (hard < limit) { limit = hard; reason += " Limited by the cap you set."; }
  return { limit, used: i.sentToday, left: Math.max(0, limit - i.sentToday), week, reason };
}
/** Midnight IST that starts the day containing `now`. */
export const dayStart = (now: number) => Date.parse(`${budgetDay(new Date(now))}T00:00:00+05:30`);
