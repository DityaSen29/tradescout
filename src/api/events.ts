/** In-process event bus per run: step changes and log lines, replayable for late SSE subscribers. */
export interface RunEvent { seq: number; at: string; type: "step" | "log" | "done" | "error"; name?: string; status?: string; info?: unknown; message?: string }
const buffers = new Map<string, RunEvent[]>();
const listeners = new Map<string, Set<(e: RunEvent) => void>>();
export function emit(runId: string, e: Omit<RunEvent, "seq" | "at">) {
  const buf = buffers.get(runId) ?? []; const ev: RunEvent = { ...e, seq: buf.length + 1, at: new Date().toISOString() };
  buf.push(ev); buffers.set(runId, buf);
  for (const l of listeners.get(runId) ?? []) l(ev);
}
export function subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
  for (const e of buffers.get(runId) ?? []) fn(e);
  const set = listeners.get(runId) ?? new Set(); set.add(fn); listeners.set(runId, set);
  return () => { set.delete(fn); };
}
export const history = (runId: string) => buffers.get(runId) ?? [];
