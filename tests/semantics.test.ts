import { describe, it, expect } from "vitest";
import { resolveHs } from "../src/semantics/hs.js";
import { resolveCountry } from "../src/semantics/country.js";
import { buildKeywordMap } from "../src/semantics/keywords.js";
import { parseRequest } from "../src/semantics/parse.js";

describe("HS resolution", () => {
  it("maps industrial textiles to a textile heading", () => {
    const r = resolveHs("industrial textiles");
    expect(r.best).not.toBeNull();
    expect(["56", "59", "52", "54", "55"]).toContain(r.best!.code.slice(0, 2));
  });
  it("maps basmati rice to 1006", () => {
    expect(resolveHs("basmati rice").best!.code.startsWith("1006")).toBe(true);
  });
  it("maps leather handbags to 4202", () => {
    expect(resolveHs("leather handbags").best!.code.startsWith("4202")).toBe(true);
  });
  it("gives the same answer for two wordings", () => {
    expect(resolveHs("Basmati Rice").best!.code).toBe(resolveHs("rice, basmati").best!.code);
  });
  it("returns none for gibberish", () => {
    expect(resolveHs("zxqv blorp").status).toBe("none");
  });
});

describe("country resolution", () => {
  it("accepts ISO3, ISO2, names and aliases", () => {
    expect(resolveCountry("DEU")!.iso3).toBe("DEU");
    expect(resolveCountry("de")!.iso3).toBe("DEU");
    expect(resolveCountry("Germany")!.iso3).toBe("DEU");
    expect(resolveCountry("the UAE")!.iso3).toBe("ARE");
    expect(resolveCountry("United States")!.iso3).toBe("USA");
  });
  it("returns null for an unknown place", () => {
    expect(resolveCountry("Narnia")).toBeNull();
  });
});

describe("keyword map", () => {
  it("expands a product into distributor language and industries", () => {
    const k = buildKeywordMap("industrial textiles");
    expect(k.families).toContain("technical_textiles");
    expect(k.query).toMatch(/distributor/);
    expect(k.expansions.length).toBeGreaterThan(2);
  });
});

describe("parse step", () => {
  it("produces a filter plan for a clear request", () => {
    const r = parseRequest({ product: "basmati rice", target_country: "UAE", min_headcount: 20, max_headcount: 2000 });
    expect(r.status).toBe("ok");
    expect(r.filter_plan.country_iso3).toBe("ARE");
    expect(r.evidence.length).toBe(2);
  });
  it("says cannot verify for an unknown country instead of guessing", () => {
    const r = parseRequest({ product: "basmati rice", target_country: "Narnia", min_headcount: 20, max_headcount: 2000 });
    expect(r.status).toBe("cannot_verify");
    expect(r.questions[0]).toMatch(/cannot verify/);
  });
});
