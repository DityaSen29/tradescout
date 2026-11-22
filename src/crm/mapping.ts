import type { Lead } from "../buyer/contract.js";
import type { Kind, Props } from "./adapter.js";

/** The only lead data that may leave for a CRM. No claims, reasons, customs behaviour, scores or product. */
export interface SyncLead {
  lead_id: string; client_id: string; company: string; domain: string; match: string; status: string;
  contact: { first: string; last: string; title: string; email: string } | null;
}
export interface Mapped { props: Props; natural: string }

const clean = (v: unknown, max = 250) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

/** Throws on a lead that cannot be keyed or named: a bad key would make duplicates. */
export function minimise(lead: Lead, status: string): SyncLead {
  if (typeof lead?.lead_id !== "string" || !/^[^\s/?#]{1,200}$/.test(lead.lead_id) || /^\.+$/.test(lead.lead_id)) throw new Error("lead_id is missing or unsafe");
  const company = clean(lead.company?.name);
  if (!company) throw new Error("company name is missing");
  if (!clean(lead.client_id)) throw new Error("client_id is missing");
  const host = clean(lead.company.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const c = lead.contact, name = clean(c?.name).split(" ").filter(Boolean);
  const rawEmail = clean(c?.email).toLowerCase();
  // a work email only when it was not found to be bad
  const email = c && c.email_status !== "invalid" && c.email_status !== "not_found" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : "";
  return {
    lead_id: lead.lead_id, client_id: lead.client_id, company, status: clean(status), match: clean(lead.match),
    domain: /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) ? host : "",
    contact: c && (name.length || email) ? { first: name[0] ?? "", last: name.slice(1).join(" "), title: clean(c.title), email } : null,
  };
}

/** A blank value is left out, so a thin re-run never erases what is in the CRM. */
const present = (names: readonly string[], values: string[]): Props => Object.fromEntries(names.map((k, i) => [k, values[i]]).filter(([, v]) => v));

export function mapLead(l: SyncLead, ours: Record<Kind, readonly string[]>): Record<Kind, Mapped | null> {
  return {
    company: { natural: l.domain, props: present(ours.company, [l.company, l.domain]) },
    contact: l.contact && { natural: l.contact.email, props: present(ours.contact, [l.contact.first, l.contact.last, l.contact.title, l.contact.email]) },
    deal: { natural: "", props: present(ours.deal, [l.company, l.match, l.status]) },
  };
}
