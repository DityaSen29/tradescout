import { loadRows, runQueries, type Row } from "./customs.js";
import type { CustomsQuery } from "./plan.js";

/**
 * Where shipment records come from. The pipeline knows only this interface.
 *
 * To add a vendor API (Eximpedia, Volza, Datamyne, Panjiva):
 *   1. implement CustomsSource and map the vendor's fields onto Row
 *   2. register it below
 *   3. if it bills per call, add the vendor to src/core/limits.ts as a paid provider and set `maxUnits`
 * Vendor licences differ on showing rows to clients. Check before switching one on.
 */
export interface CustomsSource {
  id: string;
  /** Source name for the ledger and the caps. */
  billedAs: string;
  maxUnits?: number;
  query(queries: CustomsQuery[]): Promise<{ inMarket: number; hits: Row[]; units?: number }>;
}

export const fileSource: CustomsSource = {
  id: "export-files",
  billedAs: "customs",
  query: async (queries) => runQueries(loadRows(), queries),
};

const SOURCES: Record<string, CustomsSource> = { files: fileSource };
export const PLANNED_SOURCES = ["eximpedia", "volza", "datamyne", "panjiva"];

export function customsSource(id = process.env.CUSTOMS_SOURCE ?? "files"): CustomsSource {
  const s = SOURCES[id];
  if (!s) throw new Error(PLANNED_SOURCES.includes(id) ? `the ${id} customs API is not connected yet: use CUSTOMS_SOURCE=files` : `unknown customs source "${id}"`);
  return s;
}
