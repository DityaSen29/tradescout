import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { Ledger } from "../src/ledger/ledger.js";
import { runPipeline } from "../src/runner/pipeline.js";
import { askJson } from "../src/agents/llm.js";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("model calls", () => {
  it("retry one timeout, with both attempts counted against the cap", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      if (++n === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
    });
    const l = new Ledger(":memory:");
    const run = l.createRun({ product: "widgets", target_country: "USA", min_headcount: 20, max_headcount: 2000 });
    const out: any = await runPipeline(l, run, [{ name: "s", run: (ctx) => askJson(ctx, { agent: "planner", task: "t", data: {}, schema: z.object({ ok: z.boolean() }) }) }]);
    expect([n, out.s.ok]).toEqual([2, true]);
    expect(l.listCalls(run).map(c => c.status).sort()).toEqual(["error", "ok"]);
    expect(Number((l.db.prepare("SELECT COUNT(*) n FROM spend").get() as any).n)).toBe(2);
  });
});
