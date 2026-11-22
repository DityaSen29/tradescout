export interface MailMessage {
  id: string; threadId: string; at: number;
  labels: string[];
  headers: Record<string, string>;
  /** Plain text of every readable part, including delivery-status parts. */
  text: string;
}
export interface OutgoingMail {
  to: string; toName?: string; subject: string; body: string;
  /** Searched for before a retry. */
  key: string;
  threadId?: string | null; inReplyTo?: string | null; references?: string | null;
  kind?: "campaign" | "alert";
}
/** The engine knows only this, so Gmail and the simulated mailbox run the same code path. */
export interface Mailbox {
  readonly email: string;
  send(m: OutgoingMail): Promise<{ id: string; threadId: string }>;
  get(id: string): Promise<MailMessage>;
  thread(id: string): Promise<MailMessage[]>;
  /** Gmail query syntax. Returns every page, or throws: a partial answer must not look like "no reply". */
  search(q: string): Promise<{ id: string; threadId: string }[]>;
}

export const KEY_HEADER = "X-TradeScout-Key";
export const ALERT_HEADER = "X-TradeScout-Alert";
export const fromAddress = (m: MailMessage) => {
  const raw = m.headers.from ?? "";
  return (raw.match(/<([^<>]+)>\s*$/)?.[1] ?? raw).trim().toLowerCase();
};
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
function encodeWord(s: string): string {
  const clean = oneLine(s);
  if (/^[\x20-\x7e]*$/.test(clean) && !clean.includes("=?")) return clean;
  // chunk by character so no UTF-8 sequence is split across encoded words
  const words: string[] = [];
  let part = "";
  for (const ch of clean) {
    if (Buffer.byteLength(part + ch) > 42) { words.push(part); part = ""; }
    part += ch;
  }
  if (part) words.push(part);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

export function buildMime(from: string, m: OutgoingMail): string {
  const name = m.toName ? oneLine(m.toName).replace(/["\\<>]/g, "") : "";
  const shown = name && (/^[\x20-\x7e]+$/.test(name) ? `"${name}"` : encodeWord(name));
  const head = [
    `From: <${oneLine(from)}>`,
    `To: ${shown ? `${shown} <${oneLine(m.to)}>` : `<${oneLine(m.to)}>`}`,
    `Subject: ${encodeWord(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    `${KEY_HEADER}: ${oneLine(m.key)}`,
  ];
  if (m.kind === "alert") head.push(`${ALERT_HEADER}: 1`, "Auto-Submitted: auto-generated");
  else head.push(`List-Unsubscribe: <mailto:${oneLine(from)}?subject=unsubscribe>`);
  if (m.inReplyTo) head.push(`In-Reply-To: ${oneLine(m.inReplyTo)}`, `References: ${oneLine(m.references ?? m.inReplyTo)}`);
  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n")).toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${head.join("\r\n")}\r\n\r\n${body}`;
}
