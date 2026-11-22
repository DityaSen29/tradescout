import { describe, it, expect } from "vitest";
import { productNoun, sellerOrigin, sellerClaim, DEFAULT_ORIGIN } from "../src/buyer/origin.js";
import { buysFrom } from "../src/buyer/customs.js";
import { PlanSchema } from "../src/buyer/plan.js";

const read = (text: string, country: string, quote: string, marketIso3 = "USA") => sellerOrigin({ text, proposed: { country, quote }, marketIso3 });

describe("seller origin", () => {
  it("comes from the seller's own words", () => {
    expect(read("We make menthol crystals in Anhui, China.", "China", "in Anhui, China")).toMatchObject({ iso3: "CHN", source: "prompt" });
    expect(read("Steel gratings, made in Pune", "India", "made in Pune")).toMatchObject({ iso3: "IND", source: "prompt" });
  });
  it("is not taken from words the seller never wrote", () => {
    expect(read("We make steel gratings.", "Germany", "made in Germany")).toEqual(DEFAULT_ORIGIN);
    expect(read("We make chinaware.", "China", "china")).toEqual(DEFAULT_ORIGIN);
    expect(read("We make gratings.", "Germany", "")).toEqual(DEFAULT_ORIGIN);
  });
  it("is not the target market", () => expect(read("Find buyers in the United States", "United States", "united states")).toEqual(DEFAULT_ORIGIN));
  it("is not a country we cannot resolve", () => expect(read("Made in Narnia", "Narnia", "made in narnia")).toEqual(DEFAULT_ORIGIN));
  it("an explicit field wins, and a bad one stops the run", () => {
    const p = { text: "made in Pune", proposed: { country: "India", quote: "made in Pune" }, marketIso3: "USA" };
    expect(sellerOrigin({ ...p, given: "Germany" })).toMatchObject({ iso3: "DEU", source: "request" });
    expect(() => sellerOrigin({ ...p, given: "Narnia" })).toThrow(/cannot verify/);
  });
  it("never tells a buyer an origin it only assumed", () => {
    expect(sellerClaim("widgets", DEFAULT_ORIGIN)).toBe("We supply widgets.");
    expect(sellerClaim("widgets", { iso3: "DEU", name: "Germany", source: "prompt", quote: "in germany" })).toBe("We supply widgets from Germany.");
  });
  it("names the product as a noun when the brief is a sentence", () => {
    expect(productNoun("steel gratings")).toBe("steel gratings");
    expect(productNoun("We make menthol crystals in Pune.", "menthol crystals")).toBe("menthol crystals");
    expect(productNoun("We make menthol crystals in Pune.", "organic menthol")).toBe("this product");
  });
  it("ranks on the seller's country, whatever it is", () => {
    const rows = [{ origin: "CN, CHINA" }, { origin: null }];
    expect([buysFrom(rows, "CHN"), buysFrom(rows, "IND")]).toEqual([true, false]);
    expect(buysFrom([{ origin: "IN, INDIA" }], "IND")).toBe(true);
  });
  it("a malformed reading does not fail the plan", () => {
    const plan = { understanding: "u", product_spec: "p", hs_candidates: [{ code: "730890", why: "w" }], include_terms: ["x"], exclude_terms: [], end_uses: [], buyer_types: ["b"], not_buyers: [], company_search: "q" };
    expect(PlanSchema.parse({ ...plan, seller_origin: "Germany" }).seller_origin).toBeNull();
  });
});
