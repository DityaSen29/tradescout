import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ledger } from "../ledger/ledger.js";
import { address, hasSecret, secretPath } from "./config.js";
import { httpJson, type Call } from "./io.js";
import { buildMime, KEY_HEADER, type Mailbox, type MailMessage, type OutgoingMail } from "./mail.js";
import { open, seal } from "./secrets.js";
import { store } from "./store.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

const CLIENT_FILE = "google-desktop-client.json";
interface Client { id: string; secret: string }
export function googleClient(): Client | null {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET)
    return { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
  // Its own file name and Desktop clients only: a web client can't redirect here, and a production
  // client left in another file must never be picked up by accident.
  if (!hasSecret(CLIENT_FILE)) return null;
  try {
    const c = JSON.parse(readFileSync(secretPath(CLIENT_FILE), "utf8")).installed;
    if (!c?.redirect_uris?.some((u: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u))) return null;
    return c?.client_id && c?.client_secret ? { id: c.client_id, secret: c.client_secret } : null;
  } catch { return null; }
}

/** Offline consent with PKCE and a single-use, ten-minute state. */
export class OAuthFlow {
  private pending = new Map<string, { verifier: string; redirect: string; expires: number }>();
  start(redirect: string): string {
    const c = googleClient();
    if (!c) throw new Error("No Google OAuth client yet: save the downloaded JSON as ~/.tradescout/google-desktop-client.json");
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, redirect, expires: Date.now() + 600_000 });
    return `${AUTH}?${new URLSearchParams({
      client_id: c.id, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
      access_type: "offline", prompt: "consent", state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })}`;
  }
  async finish(ledger: Ledger, call: Call, code: string, state: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new Error("This sign-in link expired or was already used. Start again.");
    const c = googleClient();
    if (!c) throw new Error("The Google OAuth client is missing.");
    const { data: t } = await call({ source: "gmail", endpoint: "oauth/token", request: { grant: "code" }, cacheable: false }, () =>
      httpJson<any>("Google sign-in", TOKEN, {
        method: "POST",
        body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: p.redirect, grant_type: "authorization_code", code_verifier: p.verifier }),
      }));
    const granted = String(t.scope ?? "").split(" ");
    if (!SCOPES.every(s => granted.includes(s))) throw new Error("Both Gmail permissions are needed: send, and read (to check for replies before a follow-up). Connect again and tick both.");
    if (!t.refresh_token) throw new Error("Google gave no offline token. Remove the app's access in your Google account and connect again.");
    const { data: profile } = await call({ source: "gmail", endpoint: "profile", request: {}, cacheable: false }, () =>
      httpJson<any>("Gmail profile", `${API}/profile`, { headers: { authorization: `Bearer ${t.access_token}` } }));
    const email = address(profile.emailAddress);
    if (!email) throw new Error("Gmail returned no mailbox address.");
    store(ledger).saveMailbox(email, "gmail", seal(String(t.refresh_token), email));
    return email;
  }
}

function plainText(part: any): string {
  const out: string[] = [], html: string[] = [];
  const walk = (p: any, depth: number) => {
    if (!p || depth > 15) return;
    if (p.body?.data) {
      const s = Buffer.from(p.body.data, "base64url").toString("utf8");
      if (p.mimeType === "text/plain" || /^message\//.test(p.mimeType ?? "")) out.push(s);
      else if (p.mimeType === "text/html") html.push(s.replace(/<(script|style)[\s\S]*?<\/\1>|<blockquote[\s\S]*<\/blockquote>/gi, " ")
        .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&"));
    }
    for (const child of p.parts ?? []) walk(child, depth + 1);
  };
  walk(part, 0);
  return (out.join("\n").trim() ? out : html).join("\n").slice(0, 30_000);
}
const toMessage = (m: any): MailMessage => ({
  id: m.id, threadId: m.threadId, at: Number(m.internalDate), labels: m.labelIds ?? [],
  headers: Object.fromEntries((m.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value)])),
  text: plainText(m.payload) || String(m.snippet ?? ""),
});

const tokens = new Map<string, { value: string; expires: number; sealed: string }>();

export class GmailMailbox implements Mailbox {
  constructor(readonly email: string, private sealed: string, private call: Call) {}

  private async token(): Promise<string> {
    const hit = tokens.get(this.email);
    if (hit && hit.sealed === this.sealed && hit.expires > Date.now() + 60_000) return hit.value;
    const c = googleClient();
    if (!c) throw new Error("The Google OAuth client is missing.");
    const { data } = await this.call({ source: "gmail", endpoint: "oauth/refresh", request: { mailbox: this.email }, cacheable: false }, () =>
      httpJson<any>("Google token refresh", TOKEN, {
        method: "POST",
        body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: "refresh_token", refresh_token: open(this.sealed, this.email) }),
      }));
    tokens.set(this.email, { value: data.access_token, sealed: this.sealed, expires: Date.now() + Number(data.expires_in ?? 0) * 1000 });
    return data.access_token;
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const token = await this.token();
    const endpoint = path.split("?")[0].replace(/\/[0-9a-f]{12,}/g, "/:id");
    const { data } = await this.call({ source: "gmail", endpoint, request: { path, mailbox: this.email }, cacheable: false }, () =>
      httpJson<T>("Gmail", API + path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }));
    return data;
  }
  async send(m: OutgoingMail) {
    const raw = Buffer.from(buildMime(this.email, m)).toString("base64url");
    const r = await this.request<any>("/messages/send", { raw, ...(m.threadId ? { threadId: m.threadId } : {}) });
    if (!r.id || !r.threadId) throw new Error(`Gmail accepted the send without returning an id (${KEY_HEADER} will be checked)`);
    return { id: String(r.id), threadId: String(r.threadId) };
  }
  async get(id: string) { return toMessage(await this.request(`/messages/${encodeURIComponent(id)}?format=full`)); }
  async thread(id: string) {
    const r = await this.request<any>(`/threads/${encodeURIComponent(id)}?format=full`);
    if (!Array.isArray(r.messages)) throw new Error("Gmail returned a thread without messages");
    return r.messages.map(toMessage);
  }
  async search(q: string) {
    const found: { id: string; threadId: string }[] = [];
    let page = "";
    for (let i = 0; i < 10; i++) {
      const r = await this.request<any>(`/messages?${new URLSearchParams({ q, maxResults: "100", includeSpamTrash: "true", ...(page ? { pageToken: page } : {}) })}`);
      if (r.messages !== undefined && !Array.isArray(r.messages)) throw new Error("Gmail returned an unreadable search");
      found.push(...(r.messages ?? []));
      if (!r.nextPageToken) return found;
      page = r.nextPageToken;
    }
    throw new Error("Gmail search was too large to check completely");
  }
}
