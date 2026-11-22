import type { Evidence } from "../core/types.js";
import { Crustdata } from "../sources/crustdata.js";
import { resolveCountry } from "../semantics/country.js";

let client: Crustdata | null = null;
export const crust = () => (client ??= new Crustdata());

/** A citation for a field of an API record: endpoint, record id, field, retrieved-at. */
export const apiEvidence = (claim: string, endpoint: string, record_id: string, field: string, retrieved_at: string, record_date: string | null = null): Evidence => ({
  claim, source_type: "crustdata", source_url: `https://api.crustdata.com${endpoint}#record=${encodeURIComponent(record_id)}&field=${encodeURIComponent(field)}`,
  record_id, field, record_date, retrieved_at,
});
export const iso3Of = (raw: string | null) => (raw ? resolveCountry(raw)?.iso3 ?? raw : null);

export const SEARCH_FIELDS = [
  "basic_info.name", "basic_info.primary_domain", "basic_info.website", "basic_info.description", "basic_info.year_founded",
  "basic_info.professional_network_url", "basic_info.industries", "locations.country", "locations.city", "locations.headquarters",
  "headcount.total", "headcount.growth_percent.6m", "headcount.growth_percent.12m",
];
export const BUYING_TITLE = /\b(procure|purchas|sourcing|buyer|buying|supply chain|category|import|merchandis|einkauf|achats|acquisti|compras)\w*/i;
export const ADVERSE = /\b(layoff|lay-off|redundanc|insolven|bankrupt|administration|liquidat|fraud|lawsuit|sued|investigat|sanction|fine[ds]?|penalt|closure|shut down|scandal|default)\w*/i;
