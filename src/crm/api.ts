import type { CrmSync } from "./engine.js";
import type { CrmHub } from "./hub.js";
import type { Conflict } from "./store.js";

/** The JSON a UI needs, with the words and choices for each decision, so any UI can be thin. */
export function connectionView(sync: CrmSync, opts: { simulated?: boolean; hub?: CrmHub } = {}) {
  const { leads, conflicts, paused, connected, error, ...rest } = sync.status();
  const saved = opts.hub?.describe().find(c => c.key === sync.store.crm);
  const key = !!opts.simulated || (opts.hub ? !!saved?.ready : !!process.env.HUBSPOT_TOKEN);
  return {
    ...rest, error, simulated: !!opts.simulated,
    client: saved?.client ?? "*",
    state: !key ? "no_key" : connected ? "connected" : error ? "error" : "unchecked",
    inbound: rest.notifications.until && rest.notifications.until > Date.now() ? "notifications and polling" : "polling",
    poll_ms: sync.adapter.pollMs,
    queued: leads.filter(l => ["pending", "retry", "in_flight", "failed"].includes(l.state)).length,
    open_conflicts: conflicts.length,
    paused: paused.length,
    providers: { hubspot: "implemented", zoho: "implemented" },
  };
}

const WORDS: Record<Conflict["type"], (c: Conflict) => [title: string, detail: string, approve: string, reject: string]> = {
  field: c => [`${c.field} was edited in the CRM`, `Meridian: "${c.ours}". CRM: "${c.theirs || "(blank)"}".`, "Use Meridian's", "Keep the CRM's"],
  duplicate: c => [`A ${c.kind} like this is already in the CRM`, `Matches ${c.ours.replace(/^name:/, "the name ")}: ${c.theirs || "no details"} (record ${c.remote_id}).`, "Link to it", "Don't sync it"],
  person: c => ["A different decision-maker was found", `The CRM contact is ${c.theirs}. Meridian now has ${c.ours}.`, "Replace the contact", "Keep the first person"],
  delete: c => [`The ${c.kind} was deleted in the CRM`, `Record ${c.remote_id}. Writes to it are paused.`, "Accept the delete", "Recreate it"],
  merge: c => [c.ours === "possible" ? `The ${c.kind} is gone and may have been merged` : `The ${c.kind} was merged in the CRM`,
    c.ours === "possible" ? `Record ${c.remote_id} is gone. Record ${c.theirs} matches it. Writes to it are paused.` : `Record ${c.remote_id} is now ${c.theirs}. Writes to it are paused.`,
    "Follow the merge", "Stop syncing it"],
};
export function conflictsView(sync: CrmSync) {
  return sync.status().conflicts.map(c => {
    const [title, detail, approve, reject] = WORDS[c.type](c);
    return { ...c, title, detail, needs_confirmation: c.type !== "field", choices: { approve, reject } };
  });
}
