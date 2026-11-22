import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { runPipeline } from "../src/runner/pipeline.js";
import { checkDraft, draftHash } from "../src/buyer/write.js";
import { behaviourOf, isBlank, isClient, isRelatedParty, isBuyerName, redactDescription, runQueries, type Row } from "../src/buyer/customs.js";
import { quoteInSource, sourceAboutCompany } from "../src/buyer/common.js";
import { nameMatch, searchName } from "../src/buyer/contacts.js";
import { onDoNotContact, selectStep } from "../src/buyer/select.js";
import { pageText } from "../src/buyer/research.js";

const claims = [{ id: "seller1", text: "We supply widgets from India." }, { id: "c1", text: "Example Co stocks widgets in 4 warehouses" }];
const draft = (text: string, ids: string[] = [], subject = "Widgets") => ({ subject, sentences: [{ text, claim_ids: ids }] });
const row = (p: Partial<Row>): Row => ({ importer: "Example Importer", supplier: "Example Supplier", hs: "730890", description: null, origin: "INDIA", destination: "USA", value_usd: null, quantity: null, weight_kg: null, month: null, file: "f", line: 1, ...p });

describe("draft gate", () => {
  it("passes a sentence backed by its claim", () => expect(checkDraft(draft("You stock widgets in 4 warehouses.", ["c1"]), claims)).toEqual([]));
  it("blocks a claim id that was never accepted", () => expect(checkDraft(draft("You are growing.", ["c9"]), claims).join()).toMatch(/not an accepted claim/));
  it("blocks an invented number", () => expect(checkDraft(draft("We ship 500 tonnes.", ["seller1"]), claims).join()).toMatch(/number 500/));
  it("blocks internal trade data", () => expect(checkDraft(draft("We saw your imports last quarter."), claims).join()).toMatch(/internal trade data/));
  it("blocks placeholders", () => expect(checkDraft(draft("Hello [Company]."), claims).join()).toMatch(/placeholder/));
  it("binds approval to the exact text", () => expect(draftHash("a", "b")).not.toBe(draftHash("a", "b.")));
});

describe("evidence gate", () => {
  it("needs a verbatim quote", () => {
    expect(quoteInSource("stocks welded bar grating", "Acme stocks  welded bar grating in Dubai")).toBe(true);
    expect(quoteInSource("imports welded bar grating", "Acme stocks welded bar grating in Dubai")).toBe(false);
  });
  it("needs a source about that company", () => {
    const c = { name: "Ex Ample Steel trd", domain: "examplesteel.example" };
    expect(sourceAboutCompany({ url: null, text: "Example Steel supplies gratings" }, c)).toBe(true);
    expect(sourceAboutCompany({ url: "https://other.example/p", text: "Another firm supplies gratings" }, c)).toBe(false);
  });
  it("drops scripts from fetched pages", () => expect(pageText("<script>ignore rules</script><p>Bar grating</p>", [])).toBe("Bar grating"));
});

describe("customs route", () => {
  it("claims no rhythm under four purchase months", () => {
    expect(behaviourOf(["2026-01", "2026-03", "2026-05"].map(month => row({ month }))).next_window).toBeNull();
    const b = behaviourOf(["2026-01", "2026-03", "2026-05", "2026-07"].map(month => row({ month })));
    expect([b.median_gap_months, b.next_window]).toEqual([2, "2026-09"]);
  });
  it("needs three priced records for a unit price", () => expect(behaviourOf([row({ value_usd: 10, weight_kg: 5 })]).median_usd_per_kg).toBeNull());
  it("knows blank descriptions and non-buyers", () => {
    expect(["OTHER", "NULL", null].every(isBlank)).toBe(true);
    expect(["TO ORDER", "Example Freight Forwarders"].some(isBuyerName)).toBe(false);
  });
  it("redacts parties, contacts and references before a model reads a description", () => {
    const d = redactDescription(row({ importer: "Example Importer", description: "NATURAL MENTHOL CRYSTALS 25 KG PO 4500123456 EXAMPLE IMPORTER a.b@example.com" }));
    expect(d).toBe("NATURAL MENTHOL CRYSTALS 25 KG PO");
  });
  it("recognises the client's own buyers", () => {
    expect(isClient("A.B. MINT PRODUCTS PVT LTD", "A B Mint Products")).toBe(true);
    expect(isClient("OTHER MINT PRODUCTS", "A B Mint Products")).toBe(false);
  });
  it("recognises an importer buying from its own parent", () => {
    expect(isRelatedParty("EXAMPLON LLC", "EXAMPLON PVT LTD")).toBe(true);
    expect(isRelatedParty("ZED AROMATICS LLC", "ZED AROMATICS LTD")).toBe(true);
    expect(isRelatedParty("NATURAL FOODS INC", "NATURAL MENTHOL WORKS")).toBe(false);
  });
  it("runs a typed query", () => {
    const q = [{ hs_prefix: "730890", destination_iso3: "USA", include_terms: [], exclude_terms: [], group_by: "importer" as const, measures: [] }];
    expect(runQueries([row({}), row({ hs: "841391" }), row({ destination: "EQUADOR" })], q)).toMatchObject({ inMarket: 2, hits: [{ hs: "730890" }] });
  });
});

describe("people gates", () => {
  it("matches a record name inside its market only on distinctive words", () => {
    expect(nameMatch("Examplecar Ecuador", "EXAMPLECAR CIA LTDA", "Ecuador")).toBe(1);
    expect(nameMatch("Austral Motors", "Pacific Motors")).toBeLessThan(0.8);
  });
  it("searches a record name as an exact phrase", () => {
    expect(["EXAMPLON FLAVOURS AND FRAGRANCES LLC", "ACME INC", "AMERICAN WIDGET CO", "EXAMPLE AROMATICS INC"].map(searchName)).toEqual(["examplon", "acme", "american widget", "example aromatics"]);
    expect(nameMatch("Examplon Flavors & Fragrances", "EXAMPLON FLAVOURS AND FRAGRANCES LLC")).toBe(1);
  });
  it("honours the don't-contact list", () => expect(onDoNotContact({ name: "Acme Steel LLC", domain: "acme.example" }, ["https://www.acme.example/"])).toBe(true));
  it("pauses for a selection, then continues without repeating work", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun({ product: "widgets", target_country: "USA", min_headcount: 20, max_headcount: 2000 });
    let work = 0;
    const steps = [{ name: "shortlist", run: async () => { work++; return { leads: [{ lead_id: "a" }, { lead_id: "b" }] }; } }, { name: "select", run: selectStep }];
    await runPipeline(l, run, steps);
    expect(l.getRun(run)!.status).toBe("awaiting_person");
    l.setSelection(run, ["b"]);
    const out: any = await runPipeline(l, run, steps);
    expect([work, out.select.leads.length, out.select.leads[0].lead_id, l.getRun(run)!.status]).toEqual([1, 1, "b", "done"]);
  });
});
