import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Ledger } from "../src/ledger/ledger.js";
import { runPipeline, type StepDef } from "../src/runner/pipeline.js";
import { BudgetExceeded } from "../src/core/types.js";
import { budgetDay } from "../src/core/limits.js";
import { Crustdata, CrustdataError } from "../src/sources/crustdata.js";

const req = { product: "sample product", target_country: "DEU", min_headcount: 20, max_headcount: 2000 };
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const paidStep = (source: string, n: number, each: number, paid: { n: number }): StepDef[] => [{ name: "spend", optional: true, run: async (ctx) => {
  for (let i = 0; i < n; i++)
    await ctx.call({ source, endpoint: "/paid", request: i, maxUnits: each, credits: () => each, model_cost_usd: () => each }, async () => { paid.n++; return {}; });
} }];

describe("hard API limits", () => {
  it("makes no call past a per-run limit", async () => {
    const l = new Ledger(":memory:"); const paid = { n: 0 };
    await expect(runPipeline(l, l.createRun(req, { credit_limit: 1 }), paidStep("crustdata", 2, 1, paid))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(paid.n).toBe(1);
  });

  it.each([["apollo", "APOLLO_RUN_LIMIT"], ["llm", "LLM_RUN_LIMIT_USD"]])("limits %s per run", async (source, name) => {
    vi.stubEnv(name, "2");
    const l = new Ledger(":memory:"); const paid = { n: 0 };
    await expect(runPipeline(l, l.createRun(req), paidStep(source, 3, 1, paid))).rejects.toThrow(/per-run/);
    expect(paid.n).toBe(2);
  });

  it.each([["crustdata", "CRUSTDATA_DAILY_LIMIT"], ["apollo", "APOLLO_DAILY_LIMIT"], ["llm", "LLM_DAILY_LIMIT_USD"]])("limits %s per day across runs", async (source, name) => {
    vi.stubEnv(name, "0.5");
    const l = new Ledger(":memory:"); const paid = { n: 0 };
    await runPipeline(l, l.createRun(req), paidStep(source, 1, 0.3, paid));
    await expect(runPipeline(l, l.createRun(req), paidStep(source, 1, 0.3, paid))).rejects.toThrow(/daily/);
    expect(paid.n).toBe(1);
  });

  it("shares the daily limit between runs in flight and between connections", () => {
    vi.stubEnv("CRUSTDATA_DAILY_LIMIT", "10");
    const dir = mkdtempSync(join(tmpdir(), "ts-limits-"));
    const a = new Ledger(join(dir, "l.db")); const b = new Ledger(join(dir, "l.db"));
    try {
      a.reserveSpend(a.createRun(req), "crustdata", 6);
      expect(() => b.reserveSpend(b.createRun(req), "crustdata", 6)).toThrow(/daily/);
    } finally { a.db.close(); b.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps the hold when the charge is unknown and releases it on a 4xx", async () => {
    const l = new Ledger(":memory:");
    const fail = (err: Error): StepDef[] => [{ name: "s", run: (ctx) => ctx.call({ source: "crustdata", endpoint: "/paid", request: 1, maxUnits: 4 }, async () => { throw err; }) }];
    const held = () => l.spendToday()[0].used_or_held;
    await expect(runPipeline(l, l.createRun(req), fail(new Error("timeout")))).rejects.toThrow("timeout");
    expect(held()).toBe(4);
    await expect(runPipeline(l, l.createRun(req), fail(new CrustdataError(400, "bad filter")))).rejects.toThrow("bad filter");
    expect(held()).toBe(4);
  });

  it("counts the maximum when no charge is reported", async () => {
    const l = new Ledger(":memory:"); const run = l.createRun(req);
    await runPipeline(l, run, [{ name: "s", run: (ctx) => ctx.call({ source: "crustdata", endpoint: "/p", request: 1, maxUnits: 7, credits: () => null }, async () => ({})) }]);
    expect(l.totals(run).credits_used).toBe(7);
  });

  it("refuses an unknown source, a missing maximum and a malformed limit", async () => {
    const l = new Ledger(":memory:");
    const call = (source: string): StepDef[] => [{ name: "s", run: (ctx) => ctx.call({ source, endpoint: "/p", request: 1 }, async () => ({})) }];
    await expect(runPipeline(l, l.createRun(req), call("new-vendor"))).rejects.toThrow(/no API limit/);
    await expect(runPipeline(l, l.createRun(req), call("apollo"))).rejects.toThrow(/maxUnits/);
    vi.stubEnv("RUN_CREDIT_LIMIT", "sixty");
    expect(() => l.createRun(req)).toThrow(/RUN_CREDIT_LIMIT/);
  });

  it("turns the day over at midnight IST", () => {
    expect(budgetDay(new Date("2026-11-22T18:29:59Z"))).toBe("2026-11-22");
    expect(budgetDay(new Date("2026-11-22T18:30:00Z"))).toBe("2026-11-23");
  });
});

describe("robustness", () => {
  it("lets one of two racing resumes pay", async () => {
    const l = new Ledger(":memory:"); const run = l.createRun(req); let paid = 0;
    const steps: StepDef[] = [{ name: "s", run: (ctx) => ctx.call({ source: "crustdata", endpoint: "/p", request: 1, maxUnits: 1 }, async () => { paid++; await new Promise(r => setTimeout(r, 20)); return {}; }) }];
    const settled = await Promise.allSettled([runPipeline(l, run, steps), runPipeline(l, run, steps)]);
    expect(settled.map(s => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(paid).toBe(1);
  });

  it("takes over a run whose process died", async () => {
    const l = new Ledger(":memory:"); const run = l.createRun(req);
    l.db.prepare("INSERT INTO run_leases VALUES (?,?)").run(run, `${deadPid()}:gone`);
    await runPipeline(l, run, []);
    expect(l.getRun(run)!.status).toBe("done");
  });

  it("never resends after a timeout until a person reconciles it", async () => {
    const l = new Ledger(":memory:"); let sent = 0;
    const a = l.proposeAction(l.createRun(req), "email_draft", "k", {});
    l.decideAction(a.id, "approved");
    await expect(l.executeAction(a.id, async () => { sent++; throw new Error("timeout after accept"); })).rejects.toThrow();
    expect((await l.executeAction(a.id, async () => { sent++; })).ran).toBe(false);
    expect(sent).toBe(1);
    expect(l.getAction(a.id)!.status).toBe("unknown");
    l.reconcileAction(a.id, "not-done");
    expect(l.getAction(a.id)!.status).toBe("approved");
  });

  it("surfaces an action whose executor died", async () => {
    const l = new Ledger(":memory:");
    const a = l.proposeAction(l.createRun(req), "email_draft", "k", {});
    l.db.prepare("UPDATE actions SET status='executing', executor=? WHERE id=?").run(`${deadPid()}:gone`, a.id);
    expect((await l.executeAction(a.id, async () => 1)).ran).toBe(false);
    expect(l.getAction(a.id)!.status).toBe("unknown");
  });

  it("executes one action per buyer across runs", async () => {
    const l = new Ledger(":memory:"); let sent = 0;
    for (const key of ["run1", "run2"]) {
      const a = l.proposeAction(l.createRun(req), "email_draft", key, { dedupe_key: "same-buyer" });
      l.decideAction(a.id, "approved");
      await l.executeAction(a.id, async () => { sent++; });
    }
    expect(sent).toBe(1);
  });

  it("retries only a request that was never sent", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      if (++n === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      return new Response('{"companies":[]}', { status: 200 });
    });
    await new Crustdata("offline-test").companySearch({ fields: ["x"] });
    expect(n).toBe(2);
    n = 0;
    vi.stubGlobal("fetch", async () => { n++; throw new Error("timeout after the request was sent"); });
    await expect(new Crustdata("offline-test").companySearch({ fields: ["x"] })).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("rejects a nonsense 200", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"oops":"nonsense"}', { status: 200 }));
    await expect(new Crustdata("offline-test").companySearch({ fields: ["x"] })).rejects.toThrow(/without a companies list/);
  });
});
