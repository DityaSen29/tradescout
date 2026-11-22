import { randomBytes, timingSafeEqual } from "node:crypto";
import { CrmError, NotConnected, scrub, type Meter } from "./adapter.js";
import { zohoAccounts, zohoApi, type Connection, type Connections, type Provider } from "./credentials.js";

const HUBSPOT_TOKEN_URL = "https://api.hubspot.com/oauth/2026-09/token";
export const HUBSPOT_SCOPES = ["oauth", ...["companies", "contacts", "deals"].flatMap(o => [`crm.objects.${o}.read`, `crm.objects.${o}.write`, `crm.schemas.${o}.read`, `crm.schemas.${o}.write`])];
/** No DELETE scope: the token itself cannot delete a record. */
export const ZOHO_SCOPES = [
  ...["accounts", "contacts", "deals"].flatMap(m => ["READ", "CREATE", "UPDATE"].map(op => `ZohoCRM.modules.${m}.${op}`)),
  "ZohoCRM.org.READ", "ZohoCRM.coql.READ", "ZohoCRM.settings.fields.READ", "ZohoCRM.settings.fields.CREATE",
  "ZohoCRM.settings.layouts.READ", "ZohoCRM.settings.pipeline.READ", "ZohoCRM.notifications.CREATE",
];

export async function tokenRequest(provider: Provider, accounts: string | undefined, form: Record<string, string>, http: typeof fetch = fetch) {
  const url = provider === "zoho" ? `${zohoAccounts(accounts)}/oauth/v2/token` : HUBSPOT_TOKEN_URL;
  let res: Response, data: any;
  try {
    res = await http(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    data = await res.json().catch(() => ({}));
  } catch { throw new CrmError(0, `${provider} sign-in server unreachable`); }
  if (res.status === 429 || /too many requests/i.test(String(data?.error_description ?? ""))) throw new CrmError(429, `${provider} is throttling token requests`, 60_000);
  if (res.status >= 500) throw new CrmError(res.status, `${provider} sign-in server error ${res.status}`);
  if (!res.ok || !data?.access_token) throw new NotConnected(`${provider} refused the sign-in: ${scrub(data?.error ?? data?.message ?? res.status)}`);
  return data as { access_token: string; refresh_token?: string; expires_in?: number; api_domain?: string };
}

/** An access token that is refreshed before it runs out, or after the CRM rejects it. */
export class TokenSource {
  private refreshing: Promise<string> | null = null;

  constructor(private connections: Connections, private key: string, private http: typeof fetch = fetch) {}

  connection(): Connection {
    const c = this.connections.get(this.key);
    if (!c) throw new NotConnected(`${this.key} is not connected`);
    return c;
  }
  async get(meter: Meter, rejected?: string): Promise<string> {
    const c = this.connection();
    if (c.token) {
      if (rejected) throw new NotConnected(`${c.provider} rejected the key (401)`);
      return c.token;
    }
    if (!c.refresh_token || !c.app_id || !c.app_secret) throw new NotConnected(`${c.provider} is not signed in`);
    if (c.access_token && (c.expires_at ?? 0) > Date.now() + 60_000 && c.access_token !== rejected) return c.access_token;
    this.refreshing ??= this.refresh(meter, c).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async refresh(meter: Meter, c: Connection): Promise<string> {
    const t = await meter("POST oauth/token", () => tokenRequest(c.provider, c.accounts_url, { grant_type: "refresh_token", client_id: c.app_id!, client_secret: c.app_secret!, refresh_token: c.refresh_token! }, this.http), 0);
    this.connections.save(c.key, tokenPatch(c, t));
    return t.access_token;
  }
}

function tokenPatch(c: Connection, t: Awaited<ReturnType<typeof tokenRequest>>) {
  return {
    provider: c.provider, client: c.client, access_token: t.access_token, expires_at: Date.now() + Number(t.expires_in ?? 1500) * 1000,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    ...(c.provider === "zoho" && t.api_domain ? { api_url: zohoApi(t.api_domain) } : {}),
    ...(c.provider === "zoho" ? { accounts_url: zohoAccounts(c.accounts_url), hook_secret: c.hook_secret ?? randomBytes(20).toString("hex") } : {}),
  };
}

/** Trade a one-time code for tokens: from the browser redirect, or a Zoho Self Client code. */
export async function exchangeCode(connections: Connections, c: Connection, code: string, redirect?: string, http: typeof fetch = fetch): Promise<Connection> {
  if (!c.app_id || !c.app_secret) throw new NotConnected("save the app's client id and secret first");
  const t = await tokenRequest(c.provider, c.accounts_url, { grant_type: "authorization_code", client_id: c.app_id, client_secret: c.app_secret, code, ...(redirect ? { redirect_uri: redirect } : {}) }, http);
  if (!t.refresh_token) throw new NotConnected(`${c.provider} returned no refresh token; approve offline access again`);
  return connections.save(c.key, tokenPatch(c, t));
}

/** The browser sign-in. The state value ties the redirect to the start, once, for ten minutes. */
export class OAuthFlow {
  private pending = new Map<string, { key: string; redirect: string; until: number }>();

  constructor(private connections: Connections, private http: typeof fetch = fetch) {}

  start(key: string, origin: string): string {
    const c = this.connections.get(key);
    if (!c?.app_id || !c.app_secret) throw new NotConnected(`save the app first: npx tsx src/crm/connect.ts ${key.split("@")[0]}`);
    const state = randomBytes(24).toString("hex"), redirect = `${origin.replace("127.0.0.1", "localhost")}/api/crm/oauth/callback`;
    for (const [s, p] of this.pending) if (p.until < Date.now()) this.pending.delete(s);
    this.pending.set(state, { key, redirect, until: Date.now() + 600_000 });
    const q = c.provider === "zoho"
      ? new URLSearchParams({ client_id: c.app_id, response_type: "code", access_type: "offline", prompt: "consent", redirect_uri: redirect, scope: ZOHO_SCOPES.join(","), state })
      : new URLSearchParams({ client_id: c.app_id, redirect_uri: redirect, scope: HUBSPOT_SCOPES.join(" "), state });
    return c.provider === "zoho" ? `${zohoAccounts(c.accounts_url)}/oauth/v2/auth?${q}` : `https://app.hubspot.com/oauth/authorize?${q}`;
  }
  async finish(q: URLSearchParams): Promise<Connection> {
    const state = q.get("state") ?? "", p = this.pending.get(state);
    if (!p || p.until < Date.now()) throw new NotConnected("this sign-in link expired or was already used; start again");
    this.pending.delete(state);
    const code = q.get("code");
    if (!code) throw new NotConnected("sign-in was cancelled in the CRM");
    let c = this.connections.get(p.key);
    if (!c) throw new NotConnected("that connection no longer exists");
    const server = q.get("accounts-server");
    if (c.provider === "zoho" && server) c = { ...c, accounts_url: zohoAccounts(server) };
    return exchangeCode(this.connections, c, code, p.redirect, this.http);
  }
}

export function sameSecret(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
