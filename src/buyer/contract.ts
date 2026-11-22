/**
 * The contract between the buyer agents and everything downstream (CRM sync, outreach, UI).
 * Changes here are additive: new fields are optional, existing fields keep their meaning.
 */
export const CONTRACT_VERSION = 1;

export type EmailStatus = "deliverable" | "catch_all" | "invalid" | "unknown" | "not_found";
/** What the evidence supports. Only import_record may be described as "imports". */
export type MatchLabel = "import_record" | "product_match" | "category_match" | "cannot_verify";

export interface Claim {
  id: string;
  lead_id: string;
  text: string;
  kind: "customs" | "web" | "company_record" | "seller";
  /** Words copied from the source. Code checks that they are in it. */
  quote: string;
  source_url: string | null;
  record_id: string | null;
  retrieved_at: string;
  verdict: "accepted" | "rejected";
  verdict_reason: string;
  /** false = internal to the seller, never quoted to the buyer (all customs figures). */
  shareable: boolean;
}

export interface BuyingBehaviour {
  records: number;
  months_active: number;
  first_month: string;            // YYYY-MM
  last_month: string;
  median_gap_months: number | null;
  next_window: string | null;     // YYYY-MM
  total_value_usd: number | null;
  total_quantity: number | null;
  net_weight_kg: number | null;
  median_usd_per_kg: number | null;
  supplier_count: number;
  top_suppliers: { name: string; share: number }[];
  origins: string[];
}

export interface Lead {
  /** Stable across runs: use as the CRM external id. */
  lead_id: string;
  client_id: string;
  run_id: string;
  company: { name: string; domain: string | null; country_iso3: string; crustdata_company_id: string | null };
  product: string;
  hs_codes: string[];
  match: MatchLabel;
  match_reason: string;
  fit_score: number;              // 0-100
  behaviour: BuyingBehaviour | null;   // internal only
  claims: Claim[];
  contact: { person_id: string; name: string; title: string; email: string | null; email_status: EmailStatus } | null;
  selected: boolean;
  needs_person: string[];
}

/** Payload of a ledger action of kind "email_draft". */
export interface OutreachDraft {
  lead_id: string;
  client_id: string;
  run_id: string;
  step: number;                   // 1 = first email
  to_name: string;
  to_title: string;
  to_email: string | null;
  to_email_status: EmailStatus;
  company: string;
  subject: string;
  body: string;
  sentences: { text: string; claim_ids: string[] }[];
  /** sha256 of subject + "\n" + body. An executor must recheck it before sending. */
  draft_hash: string;
  /** client + lead + recipient + step. The ledger executes it once across runs. */
  dedupe_key: string;
  based_on: string[];
}
