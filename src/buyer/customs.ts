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
import { customsSource } from "./customs-source.js";

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

const flatName = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\b(pvt|private|ltd|limited|inc|llc|co|company|corp|corporation|exports?)\b/g, "").replace(/[^a-z0-9]/g, "");
/** Is this supplier the client itself? Spacing and dots vary between manifests: "A B MINT", "A.B. Mint". */
export function isClient(supplier: string | null, client: string | undefined): boolean {
  if (!supplier || !client) return false;
  const s = flatName(supplier), c = flatName(client);
  return c.length >= 5 && s.length >= 5 && (s.startsWith(c) || c.startsWith(s));
}
const SHARED_WORDS = new Set("american national international global united universal general natural pacific premier royal north south east west eastern western central golden star shanghai china india indian menthol mint aroma aromatics aromatic chemical chemicals pharma steel trading industries the".split(" "));
/** A US arm buying from its Indian parent is not an open buyer. Judged on the distinctive start of both names. */
export function isRelatedParty(importer: string, supplier: string | null): boolean {
  if (!supplier) return false;
  const a = cleanName(importer).split(" "), b = cleanName(supplier).split(" ");
  if (!a[0] || a[0] !== b[0]) return false;
  return (a[0].length >= 4 && !SHARED_WORDS.has(a[0])) || (!!a[1] && a[1] === b[1]);
}

export interface CustomsOutput {
  coverage: "records" | "none"; rows_in_market: number; rows_matched: number; leads: Lead[]; needs_research: boolean; trace: Trace[];
}
/**
 * Manifest descriptions carry party names, contacts and reference numbers. The model gets none of them:
 * the row's own party names, emails, links and any number of four or more digits are removed first.
 */
export function redactDescription(r: Pick<Row, "description" | "importer" | "supplier">): string {
  let s = (r.description ?? "").toUpperCase().replace(/\S+@\S+|HTTPS?:\S+|WWW\.\S+/g, " ");
  for (const party of [r.importer, r.supplier]) {
    if (!party) continue;
    const name = party.toUpperCase().trim();
    if (name.length >= 4) s = s.split(name).join(" ");
    const head = cleanName(party).toUpperCase().split(" ").slice(0, 2).join(" ");
    if (head.length >= 7 && !/^(MENTHOL|NATURAL|STEEL|CHEMICAL)/.test(head)) s = s.split(head).join(" ");
  }
  return s.replace(/\b[A-Z-]*\d[\d./-]{3,}[A-Z0-9-]*\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}
const DESC_BATCH = 120, DESC_MAX = 840;
const DescSchema = z.object({ matches: z.array(z.number().int()), reasoning: z.string() });

export async function customsStep(ctx: StepCtx): Promise<CustomsOutput> {
  const { trace, say } = tracer(ctx);
  const plan = ctx.outputs.plan as Plan;
  const source = customsSource();
  const r = await ctx.call({ source: source.billedAs, endpoint: source.id, request: { source: source.id, queries: plan.customs_queries }, maxUnits: source.maxUnits, credits: (x) => x.units ?? null }, () => source.query(plan.customs_queries));
  const { inMarket, hits } = r.data;
  say("customs", `${plan.customs_queries.length} structured queries on the export files: ${hits.length} matching records of ${inMarket} for ${plan.country.name}`);
  if (!hits.length) {
    say("customs", `No customs coverage for this product in ${plan.country.name}. Routing to agentic research. No import will be claimed.`);
    return { coverage: "none", rows_in_market: inMarket, rows_matched: 0, leads: [], needs_research: true, trace };
  }
  // the model sees only distinct product descriptions: no importer, supplier, value or quantity
  const described = hits.filter(h => !isBlank(h.description)).map(h => ({ h, text: redactDescription(h) })).filter(x => x.text.length > 2);
  const all = [...new Set(described.map(x => x.text))];
  const descs = all.slice(0, DESC_MAX);
  if (all.length > descs.length) say("customs", `${all.length - descs.length} descriptions were not read: over the ${DESC_MAX} limit, so those records stay category-only`);
  const exact = new Set<string>();
  for (let at = 0; at < descs.length; at += DESC_BATCH) {
    const batch = descs.slice(at, at + DESC_BATCH);
    const j = await askJson(ctx, { agent: "customs-matcher", schema: DescSchema, maxOut: 3000,
      task: `You decide which shipment descriptions are this exact product. A description that only fits the broad HS heading is not a match. Return {"matches":[indexes of exact matches], "reasoning": one sentence}.`,
      data: { product: plan.product_spec, include: plan.include_terms, exclude: plan.exclude_terms, descriptions: batch.map((text, index) => ({ index, text })) } });
    let n = 0;
    for (const i of new Set(j.matches)) if (batch[i] !== undefined) { exact.add(batch[i]); n++; }
    say("customs", `${n} of descriptions ${at + 1} to ${at + batch.length} are the exact product: ${j.reasoning}`);
  }
  if (!descs.length) say("customs", "Every description in this export is blank or 'Other', so none can prove the exact product. The detailed product report is needed.");
  const groups = new Map<string, Row[]>();
  for (const h of hits) {
    if (!isBuyerName(h.importer)) continue;
    const key = cleanName(h.importer) || h.importer.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const leads: Lead[] = [];
  const client = ctx.request.client_name;
  if (!client) say("policy", "No client company name in the brief, so importers the client already supplies cannot be excluded.");
  let own = 0, related = 0;
  for (const rows of groups.values()) {
    if (rows.some(x => isClient(x.supplier, client)) || isClient(rows[0].importer, client)) { own++; continue; }
    const matched = rows.filter(x => !isBlank(x.description) && exact.has(redactDescription(x)));
    const used = matched.length ? matched : rows;
    const b = behaviourOf(used);
    const score = Math.round((matched.length ? 45 : 20) + Math.min(20, 5 * Math.log2(1 + used.length)) + Math.min(20, b.months_active * 4)
      + (b.origins.some(o => /india/i.test(o)) ? 10 : 0) + (b.total_value_usd || b.net_weight_kg ? 5 : 0));
    const lead = newLead(ctx, { name: rows[0].importer.trim(), iso3: plan.country.iso3, hs: [...new Set(used.map(x => x.hs.slice(0, 6)))],
      match: matched.length ? "import_record" : "category_match", score,
      reason: matched.length ? `${matched.length} import record(s) whose description is this product` : "imports under the HS code; the description is blank or a different product" });
    lead.behaviour = b;
    const kin = used.filter(x => isRelatedParty(x.importer, x.supplier));
    if (kin.length) {
      const share = kin.length / used.length;
      lead.needs_person.push(`possible related party: ${Math.round(share * 100)}% of these records come from ${kin[0].supplier}, which shares its name`);
      if (share >= 0.5) { lead.related_party = kin[0].supplier!; lead.fit_score = Math.max(5, lead.fit_score - 45); related++; }
    }
    const first = used[0];
    const text = matched.length ? `Imported this product: ${used.length} record(s), ${b.first_month} to ${b.last_month}` : `Imported under HS ${lead.hs_codes.join(", ")}: ${used.length} record(s). The product is not confirmed`;
    lead.claims.push({ id: hashOf([lead.lead_id, "customs"]).slice(0, 10), lead_id: lead.lead_id, text, kind: "customs",
      quote: first.description ? redactDescription(first) : `HS ${first.hs}`, source_url: null, record_id: `${first.file}:${first.line}`, retrieved_at: r.retrieved_at,
      verdict: "accepted", verdict_reason: "computed by code from the export records", shareable: false });
    if (!matched.length) lead.needs_person.push("product not identified in the record: request the detailed product report");
    leads.push(lead);
  }
  if (own) say("policy", `${own} importer(s) removed: the client already supplies them`);
  if (related) say("policy", `${related} importer(s) buy mostly from their own parent or sister company: flagged and ranked last`);
  leads.sort((a, b) => Number(!!a.related_party) - Number(!!b.related_party) || b.fit_score - a.fit_score);
  const exactLeads = leads.filter(l => l.match === "import_record" && !l.related_party).length;
  say("customs", `${leads.length} importers: ${exactLeads} with this exact product, the rest category only`);
  return { coverage: "records", rows_in_market: inMarket, rows_matched: hits.length, leads: leads.slice(0, 25), needs_research: exactLeads < 3, trace };
}
