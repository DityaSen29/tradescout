import { createHash } from "node:crypto";
import { z } from "zod";
import type { StepCtx } from "../runner/pipeline.js";
import { askJson } from "../agents/llm.js";
import { hashOf } from "../ledger/ledger.js";
import type { Claim, Lead, OutreachDraft } from "./contract.js";
import type { Plan } from "./plan.js";
import { onDoNotContact } from "./select.js";
import { tracer, type Trace } from "./common.js";

const Draft = z.object({ key: z.string(), subject: z.string().min(3).max(120), sentences: z.array(z.object({ text: z.string().min(3), claim_ids: z.array(z.string()) })).min(2).max(8) });
const Drafts = z.object({ drafts: z.array(Draft) });
const Review = z.object({ reviews: z.array(z.object({ key: z.string(), ok: z.boolean(), problems: z.array(z.string()) })) });
type D = z.infer<typeof Draft>;

const INTERNAL = /\b(customs|shipments?|shipping bills?|import (records?|data|history)|bills? of lading|you (import|imported|have been importing|buy from)|your (suppliers?|imports?))\b/i;
const PLACEHOLDER = /\[[^\]]*\]|\{\{?[^}]*\}?\}/;

/** What code refuses before the critic is even asked. Empty array = pass. */
export function checkDraft(d: Pick<D, "subject" | "sentences">, allowed: { id: string; text: string }[]): string[] {
  const out: string[] = [];
  const byId = new Map(allowed.map(a => [a.id, a.text]));
  const everything = allowed.map(a => a.text).join(" ");
  for (const s of d.sentences) {
    const unknown = s.claim_ids.filter(id => !byId.has(id));
    if (unknown.length) out.push(`cites ${unknown.join(", ")}, which is not an accepted claim for this buyer`);
    const cited = s.claim_ids.map(id => byId.get(id) ?? "").join(" ");
    for (const n of s.text.match(/\d+(?:[.,]\d+)*/g) ?? [])
      if (!new RegExp(`(^|[^\\d])${n.replace(/\./g, "\\.")}($|[^\\d])`).test(cited) && !(n === "20" && /minute/i.test(s.text))) out.push(`the number ${n} is not in the cited claim`);
    if (/https?:|www\./i.test(s.text)) out.push("contains a link");
  }
  for (const text of [d.subject, ...d.sentences.map(s => s.text)]) {
    if (INTERNAL.test(text)) out.push(`reveals internal trade data: "${text.slice(0, 60)}"`);
    if (PLACEHOLDER.test(text)) out.push("contains a placeholder");
  }
  for (const n of d.subject.match(/\d+/g) ?? []) if (!everything.includes(n)) out.push(`the number ${n} in the subject has no claim`);
  if (d.sentences.map(s => s.text).join(" ").split(/\s+/).length > 150) out.push("longer than 150 words");
  return out;
}
export const draftHash = (subject: string, body: string) => createHash("sha256").update(`${subject}\n${body}`).digest("hex");

/** Copywriter agent, then two gates: code, and a critic that reads every sentence. Two failures block the draft. */
export async function writeStep(ctx: StepCtx): Promise<{ proposed: number; blocked: { lead_id: string; problems: string[] }[]; trace: Trace[] }> {
  const { trace, say } = tracer(ctx);
  const plan = ctx.outputs.plan as Plan;
  // a match confirmed later can reveal a don't-contact company by its domain
  const leads = (ctx.outputs.contacts as { leads: Lead[] }).leads.filter(l => l.contact && !onDoNotContact(l.company, ctx.request.do_not_contact ?? []));
  const blocked: { lead_id: string; problems: string[] }[] = [];
  if (!leads.length) { say("copywriter", "No selected company has a decision-maker, so nothing was written."); return { proposed: 0, blocked, trace }; }

  const seller = [{ id: "seller1", text: `We supply ${ctx.request.product} from India.` }, ...(ctx.request.notes ? [{ id: "seller2", text: ctx.request.notes }] : [])];
  const jobs = leads.map((lead, i) => {
    const facts: Claim[] = lead.claims.filter(c => c.verdict === "accepted" && c.shareable);
    return { key: `L${i + 1}`, lead, claims: [...seller, ...facts.map(c => ({ id: c.id, text: `${c.text} | source says: ${c.quote}` }))], done: null as D | null, problems: [] as string[] };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const open = jobs.filter(j => !j.done);
    if (!open.length) break;
    say("copywriter", attempt ? `Rewriting ${open.length} rejected draft(s)` : `Writing ${open.length} emails, each from that buyer's own evidence`);
    const w = await askJson(ctx, { agent: "copywriter", schema: Drafts, maxOut: 4000,
      task: `You write first emails from an Indian exporter to buyers abroad. Write like a thoughtful senior export manager: plain, specific, warm, 60 to 110 words, no hype, no flattery, no "I hope this finds you well".
For each buyer:
1. Open on something specific to that company from its claims, in your own words, and why it makes this product relevant to them. Don't paste their description back.
2. Say what we supply, using only the seller claims. Invent no certification, price, capacity, client or location.
3. Fit the ask to the recipient's job title: a short call, or the specification to quote against, or who handles this purchase.
Never mention trade data, their imports, suppliers, volumes or prices. Never address the person by name and write no greeting or sign-off: code adds them.
Every sentence lists the claim ids it relies on ([] only for a question or request that states no fact).
Return {"drafts":[{"key","subject","sentences":[{"text","claim_ids":[]}]}]}. Make the drafts clearly different from each other.`,
      data: { product: plan.product_spec, end_uses: plan.end_uses, market: plan.country.name,
        buyers: open.map(j => ({ key: j.key, company: j.lead.company.name, recipient_title: j.lead.contact!.title, claims: j.claims, fix_these_problems: j.problems })) } });
    const passing: { j: (typeof jobs)[number]; d: D }[] = [];
    for (const j of open) {
      const d = w.drafts.find(x => x.key === j.key);
      j.problems = d ? checkDraft(d, j.claims) : ["no draft returned"];
      if (d && !j.problems.length) passing.push({ j, d }); else say("critic", `Sent back ${j.lead.company.name}: ${j.problems[0]}`);
    }
    if (!passing.length) continue;
    const v = await askJson(ctx, { agent: "draft-critic", schema: Review, maxOut: 2000,
      task: `You are the draft critic. Check every sentence and the subject of each email against the claims it cites. Fail an email if any factual statement about the buyer or seller isn't supported, if it overstates (category evidence presented as exact product use), or if it would embarrass the sender. A reasonable hedged suggestion ("may be relevant to your projects") and a question are fine. Return {"reviews":[{"key","ok":boolean,"problems":[]}]}.`,
      data: { emails: passing.map(({ j, d }) => ({ key: j.key, company: j.lead.company.name, subject: d.subject, sentences: d.sentences, claims: j.claims })) } });
    for (const { j, d } of passing) {
      const r = v.reviews.find(x => x.key === j.key);
      if (r?.ok) { j.done = d; say("critic", `${j.lead.company.name}: all ${d.sentences.length} sentences passed`); }
      else { j.problems = r?.problems.length ? r.problems : ["the critic did not pass it"]; say("critic", `Sent back ${j.lead.company.name}: ${j.problems[0]}`); }
    }
  }
  let proposed = 0;
  for (const j of jobs) {
    const { lead } = j, contact = lead.contact!;
    if (!j.done) { blocked.push({ lead_id: lead.lead_id, problems: j.problems }); say("critic", `Blocked the email to ${lead.company.name}. A person has to write it.`); continue; }
    const body = `Dear ${contact.name},\n\n${j.done.sentences.map(s => s.text.trim()).join(" ")}\n\nBest regards,\n[Your name]\n[Your company]`;
    const cited = new Set(j.done.sentences.flatMap(s => s.claim_ids));
    const payload: OutreachDraft = {
      lead_id: lead.lead_id, client_id: lead.client_id, run_id: ctx.runId, step: 1,
      to_name: contact.name, to_title: contact.title, to_email: contact.email, to_email_status: contact.email_status, company: lead.company.name,
      subject: j.done.subject, body, sentences: j.done.sentences, draft_hash: draftHash(j.done.subject, body),
      dedupe_key: hashOf([lead.client_id, lead.lead_id, contact.person_id, 1]),
      based_on: lead.claims.filter(c => cited.has(c.id)).map(c => c.source_url ?? c.record_id ?? c.id),
    };
    ctx.ledger.proposeAction(ctx.runId, "email_draft", `buyer:${ctx.runId}:${lead.lead_id}:1`, { ...payload });
    proposed++;
  }
  return { proposed, blocked, trace };
}
