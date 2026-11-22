import { z } from "zod";

/** A request in the customer's words, normalised. */
export const RequestSchema = z.object({
  product: z.string().min(2),
  target_country: z.string().min(2),
  min_headcount: z.number().int().min(1).default(20),
  max_headcount: z.number().int().min(1).default(2000),
  fob_price_usd: z.number().positive().optional(),
  hs_code: z.string().regex(/^\d{4,6}$/).optional(),      // the person's pick when the product was ambiguous
  notes: z.string().optional(),
});
export type TradeRequest = z.infer<typeof RequestSchema>;

export const SourceType = z.enum(["crustdata", "comtrade", "wits", "sanctions", "web", "user", "ledger"]);
export type SourceType = z.infer<typeof SourceType>;

/** Every claim carries one of these. No evidence, no claim. */
export const EvidenceSchema = z.object({
  claim: z.string(),
  source_type: SourceType,
  source_url: z.string(),
  record_id: z.string().optional(),
  field: z.string().optional(),
  record_date: z.string().nullable(),
  retrieved_at: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export type TrustTier = "GREEN" | "AMBER" | "RED";

export interface Candidate {
  company_id: string;
  name: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  headcount: number | null;
  growth_6m: number | null;
  growth_12m: number | null;
  year_founded: number | null;
  description: string | null;
  industries: string[];
  linkedin: string | null;
  fit_score: number;
  fit_reasons: string[];
  trust_tier: TrustTier;
  trust_reasons: string[];
  intent_tags: string[];
  graph_score: number;
  rank_score: number;
  contact: { name: string; title: string; company: string; linkedin: string | null } | null;
  evidence: Evidence[];
  unresolved: string[];
}

export type LayerStatus = "ok" | "unavailable" | "cannot_verify";
export interface LayerResult<T = unknown> {
  layer: string;
  status: LayerStatus;
  data?: T;
  reason?: string;
  evidence: Evidence[];
  credits: number;
  latency_ms: number;
}

export interface ProposedAction {
  id: string;
  run_id: string;
  kind: "email_draft" | "rfq_draft" | "shortlist_file";
  idempotency_key: string;
  status: "proposed" | "approved" | "rejected" | "executing" | "executed";
  payload: Record<string, unknown>;
  created_at: string;
  executed_at: string | null;
}

export interface Report {
  run_id: string;
  request: TradeRequest;
  resolved: { hs_code: string | null; hs_text: string | null; country_iso3: string | null; keywords: string[] } | null;
  summary: string;
  market: LayerResult | null;
  tariff: LayerResult | null;
  policy: LayerResult | null;
  candidates: Candidate[];
  unresolved: string[];
  actions: ProposedAction[];
  limitations: string[];
  ledger: { credits_used: number; model_cost_usd: number; calls: number; elapsed_ms: number; credit_limit: number; time_limit_ms: number };
}

export class BudgetExceeded extends Error {
  constructor(public readonly what: "time" | "credits", msg: string) { super(msg); this.name = "BudgetExceeded"; }
}
