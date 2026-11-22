import type { StepDef } from "./runner/pipeline.js";

/** M0 placeholder pipeline. M1+ replace these with the real steps. */
export function buildPipeline(): StepDef[] {
  return [
    { name: "parse", run: async (ctx) => ({ echo: ctx.request }) },
    { name: "report", run: async (ctx) => ({ run_id: ctx.runId, parse: ctx.outputs.parse }) },
  ];
}
