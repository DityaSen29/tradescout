import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { StepCtx } from "../runner/pipeline.js";
import { askJson } from "../agents/llm.js";
import { resolveCountry } from "../semantics/country.js";
import { cleanName } from "../sources/sanctions.js";
import { hashOf } from "../ledger/ledger.js";
import { newLead, tracer, type Trace } from "./common.js";
import type { BuyingBehaviour, Lead } from "./contract.js";
import type { Plan, CustomsQuery } from "./plan.js";

/** One line of an export file, as written by scripts/import-exports.py. */
export interface Row {
  importer: string; supplier: string | null; hs: string; description: string | null; origin: string | null; destination: string;
  value_usd: number | null; quantity: number | null; weight_kg: number | null; month: string | null; file: string; line: number;
}
export const customsDir = () => process.env.CUSTOMS_DIR ?? "data/customs";
export function loadRows(dir = customsDir()): Row[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".jsonl")).flatMap(f => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Row));
}

const EXTRA: Record<string, string> = { equador: "ECU", srilanka: "LKA", "sri lanka": "LKA", usa: "USA", "united states": "USA", vietnam: "VNM" };
export function rowCountry(raw: string): string | null {
  const name = raw.replace(/^[A-Z]{2},\s*/, "").trim();
  return EXTRA[name.toLowerCase()] ?? resolveCountry(name)?.iso3 ?? null;
}
/** Structured queries run in code. A model never sees or builds SQL. */
export function runQueries(rows: Row[], queries: CustomsQuery[]): { inMarket: number; hits: Row[] } {
  if (!queries.length) return { inMarket: 0, hits: [] };
  const cache = new Map<string, string | null>();
  const iso = (d: string) => { if (!cache.has(d)) cache.set(d, rowCountry(d)); return cache.get(d); };
  const market = rows.filter(r => iso(r.destination) === queries[0].destination_iso3);
  return { inMarket: market.length, hits: market.filter(r => queries.some(q => r.hs.startsWith(q.hs_prefix))) };
}

const NOT_A_BUYER = /^(to (the )?order|not available|unknown|null|n\/?a)\b|\b(freight|forwarders?|forwarding|logistics|shipping lines?|customs brokers?|express lines?)\b/i;
export const isBuyerName = (name: string) => name.trim().length > 2 && !NOT_A_BUYER.test(name.trim());
export const isBlank = (d: string | null) => !d || /^(null|other|others|n\/?a|nes|-+)?\.?$/i.test(d.trim());

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const monthNo = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthText = (n: number) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;

/** Buyer intelligence: arithmetic on the records, no model. */
export function behaviourOf(rows: Row[]): BuyingBehaviour {
  const months = [...new Set(rows.flatMap(r => (r.month ? [r.month] : [])))].sort();
  const gaps = months.slice(1).map((m, i) => monthNo(m) - monthNo(months[i]));
  const gap = months.length >= 4 ? median(gaps) : null;           // no rhythm claimed under four purchase months
  const sum = (k: "value_usd" | "quantity" | "weight_kg") => { const v = rows.flatMap(r => (r[k] ? [r[k]!] : [])); return v.length ? Math.round(v.reduce((a, b) => a + b, 0)) : null; };
  const perKg = rows.filter(r => r.value_usd && r.weight_kg).map(r => r.value_usd! / r.weight_kg!);
  const suppliers = new Map<string, number>();
  for (const r of rows) if (r.supplier) suppliers.set(r.supplier, (suppliers.get(r.supplier) ?? 0) + 1);
  const total = [...suppliers.values()].reduce((a, b) => a + b, 0);
  return {
    records: rows.length, months_active: months.length, first_month: months[0] ?? "", last_month: months.at(-1) ?? "",
    median_gap_months: gap, next_window: gap ? monthText(monthNo(months.at(-1)!) + Math.round(gap)) : null,
    total_value_usd: sum("value_usd"), total_quantity: sum("quantity"), net_weight_kg: sum("weight_kg"),
    median_usd_per_kg: perKg.length >= 3 ? Number(median(perKg).toFixed(2)) : null,
    supplier_count: suppliers.size,
    top_suppliers: [...suppliers].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, share: Number((n / total).toFixed(2)) })),
    origins: [...new Set(rows.flatMap(r => (r.origin ? [r.origin.replace(/^[A-Z]{2},\s*/, "")] : [])))].slice(0, 5),
  };
}

export interface CustomsOutput {
  coverage: "records" | "none"; rows_in_market: number; rows_matched: number; leads: Lead[]; needs_research: boolean; trace: Trace[];
}
const DescSchema = z.object({ matches: z.array(z.number().int()), reasoning: z.string() });

export async function customsStep(ctx: StepCtx): Promise<CustomsOutput> {
  const { trace, say } = tracer(ctx);
  const plan = ctx.outputs.plan as Plan;
  const r = await ctx.call({ source: "customs", endpoint: "export-files", request: { queries: plan.customs_queries } }, async () => runQueries(loadRows(), plan.customs_queries));
  const { inMarket, hits } = r.data;
  say("customs", `${plan.customs_queries.length} structured queries on the export files: ${hits.length} matching records of ${inMarket} for ${plan.country.name}`);
  if (!hits.length) {
    say("customs", `No customs coverage for this product in ${plan.country.name}. Routing to agentic research. No import will be claimed.`);
    return { coverage: "none", rows_in_market: inMarket, rows_matched: 0, leads: [], needs_research: true, trace };
  }
  // the model sees only distinct product descriptions: no importer, supplier, value or quantity
  const descs = [...new Set(hits.filter(h => !isBlank(h.description)).map(h => h.description!.trim()))].slice(0, 120);
  const exact = new Set<string>();
  if (descs.length) {
    const j = await askJson(ctx, { agent: "customs-matcher", schema: DescSchema, maxOut: 1500,
      task: `You decide which shipment descriptions are this exact product. A description that only fits the broad HS heading is not a match. Return {"matches":[indexes of exact matches], "reasoning": one sentence}.`,
      data: { product: plan.product_spec, include: plan.include_terms, exclude: plan.exclude_terms, descriptions: descs.map((text, index) => ({ index, text })) } });
    for (const i of j.matches) if (descs[i] !== undefined) exact.add(descs[i]);
    say("customs", `${exact.size} of ${descs.length} descriptions are the exact product: ${j.reasoning}`);
  }
  if (!descs.length) say("customs", "Every description in this export is blank or 'Other', so none can prove the exact product. The detailed product report is needed.");
  const groups = new Map<string, Row[]>();
  for (const h of hits) {
    if (!isBuyerName(h.importer)) continue;
    const key = cleanName(h.importer) || h.importer.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const leads: Lead[] = [];
  for (const rows of groups.values()) {
    const matched = rows.filter(x => x.description && exact.has(x.description.trim()));
    const used = matched.length ? matched : rows;
    const b = behaviourOf(used);
    const score = Math.round((matched.length ? 45 : 20) + Math.min(20, 5 * Math.log2(1 + used.length)) + Math.min(20, b.months_active * 4)
      + (b.origins.some(o => /india/i.test(o)) ? 10 : 0) + (b.total_value_usd || b.net_weight_kg ? 5 : 0));
    const lead = newLead(ctx, { name: rows[0].importer.trim(), iso3: plan.country.iso3, hs: [...new Set(used.map(x => x.hs.slice(0, 6)))],
      match: matched.length ? "import_record" : "category_match", score,
      reason: matched.length ? `${matched.length} import record(s) whose description is this product` : "imports under the HS code; the description is blank or a different product" });
    lead.behaviour = b;
    const first = used[0];
    const text = matched.length ? `Imported this product: ${used.length} record(s), ${b.first_month} to ${b.last_month}` : `Imported under HS ${lead.hs_codes.join(", ")}: ${used.length} record(s). The product is not confirmed`;
    lead.claims.push({ id: hashOf([lead.lead_id, "customs"]).slice(0, 10), lead_id: lead.lead_id, text, kind: "customs",
      quote: first.description ?? `HS ${first.hs}`, source_url: null, record_id: `${first.file}:${first.line}`, retrieved_at: r.retrieved_at,
      verdict: "accepted", verdict_reason: "computed by code from the export records", shareable: false });
    if (!matched.length) lead.needs_person.push("product not identified in the record: request the detailed product report");
    leads.push(lead);
  }
  leads.sort((a, b) => b.fit_score - a.fit_score);
  const exactLeads = leads.filter(l => l.match === "import_record").length;
  say("customs", `${leads.length} importers: ${exactLeads} with this exact product, the rest category only`);
  return { coverage: "records", rows_in_market: inMarket, rows_matched: hits.length, leads: leads.slice(0, 25), needs_research: exactLeads < 3, trace };
}
