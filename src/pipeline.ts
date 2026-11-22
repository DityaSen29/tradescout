import type { StepDef } from "./runner/pipeline.js";
import { parseRequest } from "./semantics/parse.js";

/** The TradeScout pipeline. Steps are added milestone by milestone; each is a checkpoint. */
export function buildPipeline(): StepDef[] {
  return [
    {
      name: "parse",
      run: async (ctx) => {
        const r = parseRequest(ctx.request);
        for (const e of r.evidence) ctx.evidence("request", e);
        if (r.status === "cannot_verify") throw new Error(`cannot verify request: ${r.questions.join(" ")}`);
        return r;
      },
    },
    {
      name: "report",
      run: async (ctx) => {
        const parse = ctx.outputs.parse as any;
        return {
          run_id: ctx.runId, request: ctx.request,
          resolved: { hs_code: parse.hs.best?.code ?? null, hs_text: parse.hs.best?.text ?? null, country_iso3: parse.country?.iso3 ?? null, keywords: parse.keywords.expansions },
          summary: `Resolved ${ctx.request.product} → HS ${parse.hs.best?.code ?? "?"} in ${parse.country?.name ?? "?"}`,
          candidates: [], unresolved: parse.questions, actions: [], limitations: ["search, vetting and contacts not wired yet"],
        };
      },
    },
  ];
}
