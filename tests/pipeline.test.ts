import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { runPipeline } from "../src/runner/pipeline.js";
import { buildPipeline } from "../src/pipeline.js";
import { installStub } from "./fixtures/crustdata.js";

process.env.CRUSTDATA_API_KEY = "test-key";
const req = { product: "industrial textiles", target_country: "Germany", min_headcount: 20, max_headcount: 2000, hs_code: "5911" };   // the person picked 5911 over 5906

describe("end-to-end on stubbed Crustdata", () => {
  let stub: ReturnType<typeof installStub>;
  beforeAll(() => { stub = installStub(); });
  afterAll(() => stub.restore());

  it("takes a request to a ranked, cited, approval-gated result", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req);
    const out = await runPipeline(l, run, buildPipeline());
    const r = out.report as any;
    expect(r.candidates.length).toBe(5);                       // 6 records, one duplicate merged
    const names = r.candidates.map((c: any) => c.name);
    expect(names[0]).toMatch(/Nordfaser Technische/);          // best fit, GREEN, buying signal
    const rhein = r.candidates.find((c: any) => c.name.includes("Rhein"));
    expect(rhein.trust_tier).toBe("RED");                      // insolvency news + headcount collapse
    expect(r.candidates[r.candidates.length - 1].trust_tier).toBe("RED");
    const elbe = r.candidates.find((c: any) => c.name.includes("Elbe"));
    expect(elbe.trust_tier).toBe("AMBER");                     // not enriched → insufficient data, never GREEN
    expect(elbe.unresolved.join(" ")).toMatch(/cannot verify/);
    const handels = r.candidates.find((c: any) => c.name.includes("Handels"));
    expect(handels.unresolved.join(" ")).toMatch(/lookalike/);  // lookalike flagged, not merged
    expect(r.unresolved.join(" ")).toMatch(/duplicate record 106/);
    for (const c of r.candidates) { expect(c.evidence.length).toBeGreaterThan(0); for (const e of c.evidence) { expect(e.source_url).toBeTruthy(); expect(e.retrieved_at).toBeTruthy(); } }
    expect(r.candidates[0].contact?.name).toBe("Anna Weber");
    expect(r.candidates[0].intent_tags[0]).toMatch(/buying/);
    const drafts = r.actions.filter((a: any) => a.kind === "email_draft");
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((a: any) => a.status === "proposed")).toBe(true);
    expect(r.ledger.credits_used).toBeGreaterThan(0);
    expect(r.ledger.calls).toBe(10);  // comtrade x3, wits x2, web search, company search, enrich, jobs, people
    expect(r.market.status).toBe("ok"); expect(r.tariff.data.preference).toBe(true); expect(r.policy.data.flag).toBe("AMBER"); expect(r.policy.data.items[0].date).toBe("2026-10-05");
    expect(r.monitor.status).toBe("unavailable");
  });

  it("survives a crash mid-run: resume reuses checkpoints and pays nothing twice", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req);
    const before = { ...stub.calls };
    process.env.TRADESCOUT_KILL_DURING = "contacts";
    const exit = process.exit;
    (process as any).exit = (code: number) => { throw new Error(`exit ${code}`); };
    await expect(runPipeline(l, run, buildPipeline())).rejects.toThrow("exit 137");
    (process as any).exit = exit;
    delete process.env.TRADESCOUT_KILL_DURING;
    process.env.TRADESCOUT_KILLED = "1";
    const out = await runPipeline(l, run, buildPipeline());
    delete process.env.TRADESCOUT_KILLED;
    const r = out.report as any;
    expect(l.getRun(run)!.status).toBe("done");
    expect(l.listSteps(run).find(s => s.name === "search")!.attempts).toBe(1);
    expect(l.listSteps(run).find(s => s.name === "contacts")!.attempts).toBe(2);
    expect((stub.calls["/company/search"] ?? 0) - (before["/company/search"] ?? 0)).toBe(1);   // search not re-fetched
    const withContact = r.candidates.filter((c: any) => c.contact && c.trust_tier !== "RED").length;
    expect(r.actions.filter((a: any) => a.kind === "email_draft").length).toBe(withContact);   // one draft per contact, proposed once
    expect(r.monitor.status).toBe("unavailable");                                              // first completed run of this request in this ledger
    const run2 = l.createRun(req);
    const out2 = await runPipeline(l, run2, buildPipeline());
    const m = (out2.report as any).monitor;
    expect(m.status).toBe("ok");                                                               // second run → diff against the snapshot
    expect(m.data.previous_run).toBe(run);
    expect(m.data.changes).toEqual([]);
  });

  it("marks tiers AMBER and keeps going when enrichment fails", async () => {
    const s2 = installStub({ failEnrich: true });
    try {
      const l = new Ledger(":memory:");
      const run = l.createRun(req);
      const out = await runPipeline(l, run, buildPipeline());
      const r = out.report as any;
      expect(l.getRun(run)!.status).toBe("done");
      expect(r.candidates.some((c: any) => c.trust_tier === "GREEN")).toBe(false);          // never GREEN without a record
      expect(r.candidates.find((c: any) => c.name.includes("Nordfaser Technische")).trust_reasons.join(" ")).toMatch(/insufficient data/);
      expect(r.unresolved.join(" ")).toMatch(/enrich unavailable/);
    } finally { s2.restore(); stub = installStub(); }
  });

  it("stops and asks when the HS code is a near-tie, paying nothing", async () => {
    const l = new Ledger(":memory:");
    const { hs_code, ...ambiguous } = req;
    const run = l.createRun(ambiguous);
    const before = stub.calls["/company/search"] ?? 0;
    await expect(runPipeline(l, run, buildPipeline())).rejects.toThrow(/needs input: .*5906.*5911|needs input: .*5911.*5906/);
    expect((stub.calls["/company/search"] ?? 0) - before).toBe(0);
    expect(l.totals(run).credits_used).toBe(0);
  });

  it("stops within the credit ceiling", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req, { credit_limit: 0.5 });
    await expect(runPipeline(l, run, buildPipeline())).rejects.toThrow(/credits/);
    expect(l.getRun(run)!.status).toBe("budget_exceeded");
  });
});
