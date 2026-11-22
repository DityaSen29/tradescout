import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NotConnected } from "./adapter.js";

/**
 * Which CRM each client's leads go to, and the secrets for it.
 * Secrets live outside the repo in a file only this user can read, never in the ledger.
 */
export type Provider = "hubspot" | "zoho";
export interface Connection {
  /** Also the namespace of this connection's links and events in the ledger. */
  key: string;
  provider: Provider;
  /** A client id, or "*" while there is a single CRM for everything. */
  client: string;
  /** A HubSpot service key or static app token. */
  token?: string;
  app_id?: string;
  app_secret?: string;
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
  accounts_url?: string;
  api_url?: string;
  /** Zoho echoes it in each notification. */
  hook_secret?: string;
}

export const keyOf = (provider: Provider, client: string) => (client === "*" ? provider : `${provider}@${client}`);
export const usable = (c: Connection) => !!(c.token || (c.app_id && c.app_secret && c.refresh_token));

export const ZOHO_DCS: Record<string, string> = {
  com: "https://accounts.zoho.com", in: "https://accounts.zoho.in", eu: "https://accounts.zoho.eu", au: "https://accounts.zoho.com.au",
  cn: "https://accounts.zoho.com.cn", jp: "https://accounts.zoho.jp", sa: "https://accounts.zoho.sa", ca: "https://accounts.zohocloud.ca",
};
/** The client secret is posted to this address, so only Zoho's own are accepted. */
export function zohoAccounts(dcOrUrl = "in"): string {
  const url = ZOHO_DCS[dcOrUrl] ?? dcOrUrl.replace(/\/+$/, "");
  if (!Object.values(ZOHO_DCS).includes(url)) throw new NotConnected("that is not a Zoho accounts server");
  return url;
}
export function zohoApi(url: unknown): string {
  const s = String(url ?? "");
  if (!/^https:\/\/(www|sandbox|developer)\.(zohoapis\.(com|eu|in|com\.au|com\.cn|jp|sa|ca)|zohocloud\.ca)$/.test(s)) throw new NotConnected("Zoho returned an API address that is not Zoho's");
  return s;
}

export class Connections {
  constructor(readonly file = process.env.CRM_CONNECTIONS_FILE ?? join(homedir(), ".tradescout", "crm.json")) {}

  private saved(): Connection[] {
    if (!existsSync(this.file)) return [];
    let data: any;
    try { data = JSON.parse(readFileSync(this.file, "utf8")); } catch { throw new NotConnected("the CRM connections file is unreadable"); }
    if (!Array.isArray(data?.connections)) throw new NotConnected("the CRM connections file has no connection list");
    return data.connections;
  }
  /** Saved connections, plus the two that can be set through the environment. */
  list(): Connection[] {
    const out = new Map<string, Connection>(), env = process.env;
    if (env.HUBSPOT_TOKEN) out.set("hubspot", { key: "hubspot", provider: "hubspot", client: "*", token: env.HUBSPOT_TOKEN, app_secret: env.HUBSPOT_CLIENT_SECRET });
    if (env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN)
      out.set("zoho", { key: "zoho", provider: "zoho", client: "*", app_id: env.ZOHO_CLIENT_ID, app_secret: env.ZOHO_CLIENT_SECRET, refresh_token: env.ZOHO_REFRESH_TOKEN, accounts_url: ZOHO_DCS[env.ZOHO_DC ?? "in"] ?? env.ZOHO_DC });
    for (const c of this.saved()) out.set(c.key, { ...out.get(c.key), ...c });
    return [...out.values()];
  }
  get(key: string): Connection | undefined { return this.list().find(c => c.key === key); }

  save(key: string, patch: Partial<Connection> & Pick<Connection, "provider" | "client">): Connection {
    const all = this.saved(), old = all.find(c => c.key === key);
    const next: Connection = { ...old, ...patch, key };
    const body = JSON.stringify({ connections: [...all.filter(c => c.key !== key), next] }, null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
    return next;
  }

  /** The one to show when nobody named a connection. */
  primary(): Connection | undefined {
    const ready = this.list().filter(usable);
    return ready.find(c => c.provider === process.env.CRM_PROVIDER && c.client === "*") ?? ready.find(c => c.client === "*") ?? ready[0];
  }
  /**
   * The CRM for one client's leads. Once any client has a CRM of its own, nobody falls back to a shared one:
   * a missing connection is an error, not a write into somebody else's CRM.
   */
  forClient(client: string): Connection {
    const all = this.list(), dedicated = all.filter(c => c.client !== "*");
    if (dedicated.length) {
      const own = dedicated.filter(c => c.client === client && usable(c));
      const pick = own.find(c => c.provider === process.env.CRM_PROVIDER) ?? own[0];
      if (!pick) throw new NotConnected(`client ${client} has no CRM connected`);
      return pick;
    }
    return this.primary() ?? { key: "hubspot", provider: "hubspot", client: "*" };   // queues until a key is saved
  }
}
