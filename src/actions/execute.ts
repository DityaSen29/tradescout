import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { Ledger } from "../ledger/ledger.js";
import { draftHash } from "../buyer/write.js";

/**
 * Execute an approved action exactly once. During the event, agents stay in the room:
 * an approved email draft is written as a .eml file for a person to send; nothing contacts anyone.
 */
export async function executeApproved(ledger: Ledger, actionId: string) {
  const res = await ledger.executeAction(actionId, async (a) => {
    mkdirSync("data/out", { recursive: true });
    if (a.kind === "email_draft") {
      if (a.payload.draft_hash && a.payload.draft_hash !== draftHash(String(a.payload.subject), String(a.payload.body))) throw new Error("the draft changed after it was proposed; it was not written");
      const path = `data/out/${a.idempotency_key.replace(/[^a-z0-9]+/gi, "_")}.eml`;
      if (existsSync(path)) return { path, note: "already written" };
      writeFileSync(path, `To: ${a.payload.to_email ? `${a.payload.to_name} <${a.payload.to_email}>` : `${a.payload.to_name} (no address: ${a.payload.to_title} at ${a.payload.company})`}\nSubject: ${a.payload.subject}\n\n${a.payload.body}\n\n-- sources --\n${(a.payload.based_on as string[]).join("\n")}\n`);
      return { path };
    }
    if (a.kind === "shortlist_file") {
      const path = String(a.payload.path ?? `data/out/shortlist-${a.idempotency_key}.json`);
      const step = ledger.stepOutput<any>(a.run_id, "report");
      writeFileSync(path, JSON.stringify(step?.output ?? { note: "report not found" }, null, 2));
      return { path, run: a.run_id };
    }
    return { note: `no executor for ${a.kind}` };
  });
  return { action: ledger.getAction(actionId), ...res };
}
