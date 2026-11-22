import { randomUUID } from "node:crypto";
import type { Ledger } from "../ledger/ledger.js";
import { KEY_HEADER, type Mailbox, type MailMessage, type OutgoingMail } from "./mail.js";
import { store } from "./store.js";

/** A mailbox in sqlite for demos and tests. It has no network code, so it cannot email anyone. */
export class SimMailbox implements Mailbox {
  constructor(readonly email: string, private ledger: Ledger, private now: () => number) {
    ledger.db.exec("CREATE TABLE IF NOT EXISTS outreach_sim_mail (id TEXT PRIMARY KEY, mailbox TEXT, thread TEXT, at INTEGER, json TEXT)");
  }
  private put(threadId: string, headers: Record<string, string>, text: string, labels: string[]): MailMessage {
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const m: MailMessage = { id, threadId, at: this.now(), labels, text, headers: { "message-id": `<${id}@simulated.invalid>`, ...headers } };
    store(this.ledger).run("INSERT INTO outreach_sim_mail VALUES (?,?,?,?,?)", id, this.email, threadId, m.at, JSON.stringify(m));
    return m;
  }
  private mail() { return store(this.ledger).all<{ json: string }>("SELECT json FROM outreach_sim_mail WHERE mailbox=? ORDER BY at", this.email).map(r => JSON.parse(r.json) as MailMessage); }

  async send(m: OutgoingMail) {
    const headers: Record<string, string> = { from: this.email, to: m.to, subject: m.subject, [KEY_HEADER.toLowerCase()]: m.key };
    if (m.inReplyTo) headers["in-reply-to"] = m.inReplyTo;
    const r = this.put(m.threadId ?? randomUUID().replace(/-/g, "").slice(0, 16), headers, m.body, ["SENT"]);
    return { id: r.id, threadId: r.threadId };
  }
  receive(threadId: string | null, from: string, text: string, subject = "Re: hello", headers: Record<string, string> = {}) {
    return this.put(threadId ?? randomUUID(), { from, to: this.email, subject, ...headers }, text, ["INBOX"]);
  }
  async get(id: string) {
    const m = this.mail().find(x => x.id === id);
    if (!m) throw new Error("no such simulated message");
    return m;
  }
  async thread(id: string) { return this.mail().filter(m => m.threadId === id); }
  /** The subset of Gmail search the engine uses. */
  async search(q: string) {
    const from = [...q.matchAll(/from:"?([^\s")]+)"?/g)].map(m => m[1]);
    if (q.includes("from:(mailer-daemon OR postmaster)")) from.splice(0, from.length, "mailer-daemon", "postmaster");
    const to = q.match(/to:"?([^\s")]+)"?/)?.[1];
    const after = Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
    const quoted = q.match(/(?:^|\s)"([^"]+)"/)?.[1];
    return this.mail().filter(m => m.at >= after
      && (!q.includes("in:sent") || m.labels.includes("SENT"))
      && (!from.length || from.some(f => (m.headers.from ?? "").includes(f.replace(/^\(/, ""))))
      && (!to || m.headers.to === to)
      && (!quoted || m.text.includes(quoted))).map(m => ({ id: m.id, threadId: m.threadId }));
  }
}
