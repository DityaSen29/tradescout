import { z } from "zod";
import type { Ledger } from "../ledger/ledger.js";
import { askJson } from "../agents/llm.js";
import { makeCtx } from "../runner/pipeline.js";
import type { Lead, OutreachDraft } from "./contract.js";
import type { Plan } from "./plan.js";
import { checkDraft, draftHash } from "./write.js";
import { DEFAULT_ORIGIN, productNoun, sellerClaim } from "./origin.js";

const Review = z.object({ sentences: z.array(z.object({ index: z.number().int(), ok: z.boolean(), claim_ids: z.array(z.string()), problem: z.string().nullish() })) });

export const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);

/** A person's edit passes the same gates as the copywriter's draft, and always needs approving again. */
export async function editDraft(ledger: Ledger, actionId: string, edit: { subject: string; text: string; draft_hash: string }): Promise<{ ok: boolean; problems: string[]; draft_hash?: string }> {
  const a = ledger.getAction(actionId);
  if (!a || a.kind !== "email_draft" || !["proposed", "approved"].includes(a.status)) return { ok: false, problems: ["only a draft that hasn't gone out can be edited"] };
  const p = a.payload as unknown as OutreachDraft;
  if (edit.draft_hash !== p.draft_hash) return { ok: false, problems: ["the draft changed since you opened it: reload it"] };
  const plan = ledger.stepOutput<Plan>(a.run_id, "plan")?.output;
  const lead = ledger.stepOutput<{ leads: Lead[] }>(a.run_id, "contacts")?.output?.leads.find(l => l.lead_id === p.lead_id);
  const run = ledger.getRun(a.run_id);
  if (!plan || !lead || !run) return { ok: false, problems: ["the evidence behind this draft is missing, so it can't be re-checked"] };

  const claims = [
    { id: "seller1", text: sellerClaim(productNoun(run.request.product, plan.product_name), plan.seller_origin ?? DEFAULT_ORIGIN) },
    ...(run.request.notes ? [{ id: "seller2", text: run.request.notes }] : []),
    ...lead.claims.filter(c => c.verdict === "accepted" && c.shareable).map(c => ({ id: c.id, text: `${c.text} | source says: ${c.quote}` })),
  ];
  const subject = edit.subject.trim();
  const parts = sentencesOf(edit.text);
  const all = claims.map(c => c.id);
  let problems = !subject || subject.length > 120 || !parts.length ? ["a subject (up to 120 characters) and a body are required"]
    : checkDraft({ subject, sentences: parts.map(text => ({ text, claim_ids: all })) }, claims);
  if (problems.length) return { ok: false, problems };

  ledger.restartClock(a.run_id);
  const ctx = makeCtx(ledger, a.run_id, run.request, {}, "edit", () => {});
  const r = await askJson(ctx, { agent: "draft-critic", schema: Review, maxOut: 1500,
    task: `You are the draft critic, checking an email a person edited. For each numbered item (item 0 is the subject) list the claim ids it relies on and whether it is ok. Fail any factual statement about the buyer or the seller that no claim supports, including a new location, certification, capacity, price or customer. A question, a request, a pleasantry or a hedged suggestion needs no claim. Return {"sentences":[{"index","ok","claim_ids":[],"problem"}]} with one entry per item.`,
    data: { claims, items: [subject, ...parts].map((text, index) => ({ index, text })) } });
  problems = [];
  const sentences: OutreachDraft["sentences"] = [];
  for (const [i, text] of [subject, ...parts].entries()) {
    const v = r.sentences.find(s => s.index === i);
    if (!v?.ok) problems.push(`"${text.slice(0, 70)}": ${v?.problem ?? "the critic did not pass it"}`);
    else if (i) sentences.push({ text, claim_ids: v.claim_ids.filter(id => all.includes(id)) });
  }
  if (problems.length) return { ok: false, problems };

  const blocks = p.body.split("\n\n");
  const body = [blocks[0], parts.join(" "), blocks[blocks.length - 1]].join("\n\n");
  const draft_hash = draftHash(subject, body);
  if (!ledger.reviseDraft(actionId, p.draft_hash, { ...p, subject, body, sentences, draft_hash })) return { ok: false, problems: ["the draft changed or went out while it was being checked"] };
  return { ok: true, problems: [], draft_hash };
}
