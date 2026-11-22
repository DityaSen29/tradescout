import { z } from "zod";
import type { StepCtx } from "../runner/pipeline.js";
import { askJson } from "../agents/llm.js";
import { resolveHs, lookupHs } from "../semantics/hs.js";
import { resolveCountry, type Country } from "../semantics/country.js";
import { tracer, type Trace } from "./common.js";

const S = z.string();
export const PlanSchema = z.object({
  understanding: S,
  product_spec: S,
  hs_candidates: z.array(z.object({ code: S, why: S })).min(1).max(12),
  include_terms: z.array(S).min(1).max(15),
  exclude_terms: z.array(S).max(15),
  end_uses: z.array(S).max(8),
  buyer_types: z.array(S).min(1).max(8),
  not_buyers: z.array(S).max(8),
  company_search: S,
});

export interface CustomsQuery { hs_prefix: string; destination_iso3: string; include_terms: string[]; exclude_terms: string[]; group_by: "importer"; measures: string[] }
export interface Plan extends Omit<z.infer<typeof PlanSchema>, "hs_candidates"> {
  country: Country;
  hs: { code: string; text: string; why: string; origin: "client" | "planner" }[];
  dropped_hs: { code: string; why: string }[];
  customs_queries: CustomsQuery[];
  trace: Trace[];
}

/** Planner agent: product and HSN in, a typed research plan out. Code checks every code against the official list. */
export async function planStep(ctx: StepCtx): Promise<Plan> {
  const { trace, say } = tracer(ctx);
  const country = resolveCountry(ctx.request.target_country);
  if (!country) throw new Error(`cannot verify request: I cannot verify the target country "${ctx.request.target_country}".`);
  const given = ctx.request.hs_code?.replace(/\D/g, "") || null;
  const given6 = given ? given.slice(0, given.length >= 6 ? 6 : 4) : null;
  say("planner", `Reading "${ctx.request.product}"${given ? ` with HSN ${given}` : ""} for ${country.name}`);
  const p = await askJson(ctx, { agent: "planner", schema: PlanSchema, maxOut: 2500,
    task: `You are the planner for an Indian exporter looking for overseas buyers of one exact product.
Work out precisely what the product is, then expand the HS codes: every 6-digit HS 2022 subheading it is plausibly declared under by customs, including neighbouring and catch-all codes importers use, most likely first.
Return {"understanding": one sentence of your reasoning, "product_spec": what exactly qualifies, "hs_candidates":[{"code":"six digits","why":short}], "include_terms": words found in shipment descriptions and on buyers' sites for this exact product, "exclude_terms": products under the same codes that are NOT this product, "end_uses":[], "buyer_types": kinds of company that buy or specify it, "not_buyers": kinds that look relevant but do not buy it (for example makers of the same product, freight forwarders), "company_search": one natural-language company search for likely buyers of this exact product, without a country}.`,
    data: { product: ctx.request.product, client_hsn: given, client_offer: ctx.request.notes ?? null, market: country.name, closest_codes_in_official_list: resolveHs(ctx.request.product).candidates.map(c => ({ code: c.code, text: c.text })) } });

  const hs: Plan["hs"] = [], dropped: Plan["dropped_hs"] = [];
  if (given6) {
    const hit = lookupHs(given6);
    if (!hit) throw new Error(`cannot verify request: HSN ${given} is not in the HS 2022 list. Check the code.`);
    hs.push({ code: hit.code, text: hit.text, why: "given by the client", origin: "client" });
  }
  for (const c of p.hs_candidates) {
    const code = c.code.replace(/\D/g, "").slice(0, 6);
    if (hs.some(h => h.code === code)) continue;
    const hit = code.length === 4 || code.length === 6 ? lookupHs(code) : null;
    if (!hit) { dropped.push({ code: c.code, why: "not in the official HS 2022 list" }); continue; }
    hs.push({ code: hit.code, text: hit.text, why: c.why, origin: "planner" });
  }
  if (!hs.length) throw new Error(`needs input: none of the planner's HS codes exist in the official list. Give the HSN code.`);
  say("planner", p.understanding);
  say("planner", `HSN expanded to ${hs.map(h => h.code).join(", ")}${dropped.length ? `; ${dropped.length} invented code(s) dropped by code check` : ""}`);
  say("planner", `Buyers: ${p.buyer_types.join(", ")}. Not buyers: ${p.not_buyers.join(", ") || "none named"}`);
  for (const h of hs) ctx.evidence("request", { claim: `HS ${h.code} = ${h.text}`, source_type: "comtrade", source_url: "https://comtradeapi.un.org/files/v1/app/reference/H6.json", record_id: h.code, field: "text", record_date: null, retrieved_at: new Date().toISOString() });
  const { hs_candidates, ...rest } = p;
  return { ...rest, country, hs, dropped_hs: dropped, trace,
    customs_queries: hs.map(h => ({ hs_prefix: h.code, destination_iso3: country.iso3, include_terms: p.include_terms, exclude_terms: p.exclude_terms, group_by: "importer" as const, measures: ["records", "months", "value_usd", "quantity", "net_weight_kg", "suppliers"] })) };
}
