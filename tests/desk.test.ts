import { describe, it, expect } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { editDraft } from "../src/buyer/edit.js";

function draft() {
  const l = new Ledger(":memory:");
  const run = l.createRun({ product: "widgets", target_country: "USA", min_headcount: 20, max_headcount: 2000 });
  const a = l.proposeAction(run, "email_draft", "k", { draft_hash: "h1", subject: "s", body: "b" });
  return { l, a };
}

describe("desk actions", () => {
  it("batch approval takes only the text that was shown, and repeats safely", () => {
    const { l, a } = draft();
    expect(l.approveExact(a.id, "stale").ok).toBe(false);
    expect(l.approveExact(a.id, "h1").ok).toBe(true);
    expect(l.approveExact(a.id, "h1").ok).toBe(true);
  });
  it("undo works until something is executed", async () => {
    const { l, a } = draft();
    l.approveExact(a.id, "h1");
    expect(l.undoDecision(a.id)).toBe(true);
    l.approveExact(a.id, "h1");
    await l.executeAction(a.id, async () => 1);
    expect(l.undoDecision(a.id)).toBe(false);
  });
  it("pause-all stops execution, and lifting it allows it once", async () => {
    const { l, a } = draft();
    l.approveExact(a.id, "h1");
    l.setPaused(true);
    expect((await l.executeAction(a.id, async () => 1)).ran).toBe(false);
    l.setPaused(false);
    expect((await l.executeAction(a.id, async () => 1)).ran).toBe(true);
  });
  it("an edit voids the approval", () => {
    const { l, a } = draft();
    l.approveExact(a.id, "h1");
    expect(l.reviseDraft(a.id, "h1", { draft_hash: "h2" })).toBe(true);
    expect(l.getAction(a.id)!.status).toBe("proposed");
  });
  it("refuses an edit of a stale draft before any model call", async () => {
    const { l, a } = draft();
    expect(await editDraft(l, a.id, { subject: "s", text: "Hi.", draft_hash: "stale" })).toMatchObject({ ok: false });
  });
});
