import { resolveCountry } from "../semantics/country.js";
import { squash } from "./common.js";

export interface SellerOrigin {
  iso3: string;
  name: string;
  /** request = given as a field; prompt = read from the seller's own words; default = nobody said. */
  source: "request" | "prompt" | "default";
  quote: string | null;
}

/** Used for ranking when nobody says. It is never stated to a buyer: see sellerClaim. */
export const DEFAULT_ORIGIN: SellerOrigin = { iso3: "IND", name: "India", source: "default", quote: null };

/**
 * An explicit field wins. Otherwise the planner's reading counts only when the words it quotes are the seller's own
 * and the country is a real one. A reading equal to the target market is refused: that is the market, misread.
 */
export function sellerOrigin(p: { given?: string; proposed?: { country: string; quote: string } | null; text: string; marketIso3: string }): SellerOrigin {
  if (p.given) {
    const c = resolveCountry(p.given);
    if (!c) throw new Error(`cannot verify request: I cannot verify the seller's country "${p.given}".`);
    return { iso3: c.iso3, name: c.name, source: "request", quote: null };
  }
  const quote = squash(p.proposed?.quote ?? "").replace(/^[\s"'.,]+|[\s"'.,]+$/g, "");
  if (!p.proposed || quote.length < 2) return DEFAULT_ORIGIN;
  const words = quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^\\p{L}])${words}($|[^\\p{L}])`, "u").test(squash(p.text))) return DEFAULT_ORIGIN;
  const c = resolveCountry(p.proposed.country);
  if (!c || c.iso3 === p.marketIso3) return DEFAULT_ORIGIN;
  return { iso3: c.iso3, name: c.name, source: "prompt", quote };
}

/** The product as a noun. A brief typed as a sentence ("We make ... in Pune") can't follow "We supply". */
export function productNoun(product: string, named?: string | null): string {
  const p = product.trim().replace(/[.!]+$/, "");
  if (p.split(/\s+/).length <= 8 && !/\b(we|i|our|we're)\b|[.!?\n]/i.test(p)) return p;
  const n = named?.trim().replace(/[.!]+$/, "");
  // only words the seller used
  const said = squash(product);
  return n && n.split(/\s+/).length <= 8 && squash(n).split(" ").every(w => said.includes(w)) ? n : "this product";
}

/** The seller's own claim. An assumed origin never reaches an email. */
export function sellerClaim(product: string, origin: SellerOrigin): string {
  return origin.source === "default" ? `We supply ${product}.` : `We supply ${product} from ${origin.name}.`;
}
