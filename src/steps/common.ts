import type { Evidence } from "../core/types.js";
import { Crustdata } from "../sources/crustdata.js";
import { resolveCountry } from "../semantics/country.js";

let client: Crustdata | null = null;
export const crust = () => (client ??= new Crustdata());

/** A citation for a field of an API record. The link opens the stored response locally, scrolled to the record and field; the Crustdata endpoint is named in the record id. */
export const BASE_URL = () => process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
export const apiEvidence = (claim: string, endpoint: string, record_id: string, field: string, retrieved_at: string, record_date: string | null = null, runId?: string): Evidence => ({
  claim, source_type: "crustdata",
  source_url: runId ? `${BASE_URL()}/api/runs/${runId}/record?endpoint=${encodeURIComponent(endpoint)}&id=${encodeURIComponent(record_id)}&field=${encodeURIComponent(field)}` : `https://api.crustdata.com${endpoint}#record=${encodeURIComponent(record_id)}&field=${encodeURIComponent(field)}`,
  record_id: `crustdata${endpoint}:${record_id}`, field, record_date, retrieved_at,
});
export const iso3Of = (raw: string | null) => (raw ? resolveCountry(raw)?.iso3 ?? raw : null);

export const SEARCH_FIELDS = [
  "basic_info.name", "basic_info.primary_domain", "basic_info.website", "basic_info.description", "basic_info.year_founded",
  "basic_info.professional_network_url", "basic_info.employee_count_range", "locations.country", "locations.city", "locations.headquarters", "taxonomy.professional_network_industries",
  "headcount.total", "headcount.growth_percent.6m", "headcount.growth_percent.12m",
];
export const BUYING_TITLE = /\b(procure|purchas|sourcing|buyer|buying|supply chain|category|import|merchandis|einkauf|achats|acquisti|compras)\w*/i;
export const ADVERSE = /\b(layoff|lay-off|redundanc|insolven|bankrupt|administration|liquidat|fraud|lawsuit|sued|investigat|sanction|fine[ds]?|penalt|closure|shut down|scandal|default)\w*/i;
