import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { runPipeline } from "../src/runner/pipeline.js";
import { BudgetExceeded } from "../src/core/types.js";

const req = { product: "industrial textiles", target_country: "DEU", min_headcount: 20, max_headcount: 2000 };

describe("ledger", () => {
  it("executes an approved action exactly once, even when asked twice", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req);
    const a = l.proposeAction(run, "email_draft", "draft:acme:1", { to: "x" });
    expect(l.proposeAction(run, "email_draft", "draft:acme:1", { to: "x" }).id).toBe(a.id); // idempotent propose
    expect(() => l.executeAction(a.id, async () => 1)).not.toThrow();
    l.decideAction(a.id, "approved");
    let runs = 0;
    const r1 = await l.executeAction(a.id, async () => { runs++; return "sent"; });
    const r2 = await l.executeAction(a.id, async () => { runs++; return "sent"; });
    expect(r1).toEqual({ ran: true, result: "sent" });
    expect(r2).toEqual({ ran: false, result: null });
    expect(runs).toBe(1);
    expect(l.getAction(a.id)!.status).toBe("executed");
  });

  it("stops a run that exceeds its credit ceiling", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req, { credit_limit: 1 });
    const steps = [{ name: "spend", run: async (ctx: any) => {
      await ctx.call({ source: "crustdata", endpoint: "/a", request: 1, maxUnits: 2, credits: () => 2 }, async () => "x");
      await ctx.call({ source: "crustdata", endpoint: "/b", request: 2, maxUnits: 2, credits: () => 2 }, async () => "y");
    } }];
    await expect(runPipeline(l, run, steps)).rejects.toBeInstanceOf(BudgetExceeded);
    expect(l.getRun(run)!.status).toBe("budget_exceeded");
  });
});

describe("pipeline resume", () => {
  it("reuses finished checkpoints and memoised calls after a crash", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req);
    let aRuns = 0, bRuns = 0, paid = 0;
    const steps = (crash: boolean) => [
      { name: "a", run: async (ctx: any) => { aRuns++; const r = await ctx.call({ source: "crustdata", endpoint: "/x", request: { q: 1 }, maxUnits: 3, credits: () => 3 }, async () => { paid++; return { v: 42 }; }); return r.data; } },
      { name: "b", run: async (ctx: any) => { bRuns++; if (crash) throw new Error("boom"); const r = await ctx.call({ source: "crustdata", endpoint: "/x", request: { q: 1 }, maxUnits: 3, credits: () => 3 }, async () => { paid++; return { v: 42 }; }); return { from_a: ctx.outputs.a, memo: r.cached }; } },
    ];
    await expect(runPipeline(l, run, steps(true))).rejects.toThrow("boom");
    expect(l.getRun(run)!.status).toBe("failed");
    const out = await runPipeline(l, run, steps(false));
    expect(aRuns).toBe(1);           // step a was not re-run
    expect(bRuns).toBe(2);           // step b re-ran
    expect(paid).toBe(1);            // the identical call in b was served from the per-run memo
    expect(out.b).toEqual({ from_a: { v: 42 }, memo: true });
    expect(l.getRun(run)!.status).toBe("done");
    expect(l.totals(run).credits_used).toBe(3);
  });

  it("marks an optional layer unavailable instead of failing the run", async () => {
    const l = new Ledger(":memory:");
    const run = l.createRun(req);
    const out = await runPipeline(l, run, [
      { name: "market", optional: true, run: async () => { throw new Error("comtrade timeout"); } },
      { name: "report", run: async (ctx: any) => ({ market: ctx.outputs.market }) },
    ]);
    expect((out.market as any).status).toBe("unavailable");
    expect(l.getRun(run)!.status).toBe("done");
  });
});
