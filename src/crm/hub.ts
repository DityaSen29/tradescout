import type { Ledger } from "../ledger/ledger.js";
import type { Lead } from "../buyer/contract.js";
import { NotConnected, scrub, type AdapterFactory } from "./adapter.js";
import { Connections, usable, type Connection, type Provider } from "./credentials.js";
import { CrmSync, tally, type SyncResult } from "./engine.js";
import { HubSpot } from "./hubspot.js";
import { OAuthFlow, TokenSource } from "./oauth.js";
import { Zoho } from "./zoho.js";

/** Every CRM connection for one ledger, and which client's leads go to which. */
export class CrmHub {
  readonly oauth: OAuthFlow;
  private syncs = new Map<string, CrmSync>();

  constructor(readonly ledger: Ledger, readonly connections = new Connections(), private http: typeof fetch = fetch) {
    this.oauth = new OAuthFlow(connections, http);
  }

  private factory(key: string, provider: Provider): AdapterFactory {
    const tokens = new TokenSource(this.connections, key, this.http), fetch = this.http;
    return provider === "zoho"
      ? (meter, state) => new Zoho(meter, { tokens, state, fetch, notifyUrl: process.env.ZOHO_NOTIFY_URL })
      : meter => new HubSpot(meter, { tokens, fetch });
  }
  for(c: Pick<Connection, "key" | "provider">): CrmSync {
    let sync = this.syncs.get(c.key);
    if (!sync) this.syncs.set(c.key, (sync = new CrmSync(this.ledger, this.factory(c.key, c.provider), c.key)));
    return sync;
  }
  /** A named connection, or the primary one. Null for a name nobody saved. */
  pick(key?: string | null): CrmSync | null {
    if (key) { const c = this.connections.get(key); return c ? this.for(c) : null; }
    return this.for(this.connections.primary() ?? { key: "hubspot", provider: "hubspot" });
  }
  configured(): boolean { return this.connections.list().some(usable); }
  active(): CrmSync[] { return this.connections.list().filter(usable).map(c => this.for(c)); }
  /** Connections without their secrets. */
  describe() {
    return this.connections.list().map(c => ({ key: c.key, provider: c.provider, client: c.client, ready: usable(c), auth: c.token ? "key" : "oauth" }));
  }

  private adoptUnsent(to: CrmSync) {
    if (to.store.crm === "hubspot" || to.store.crm.includes("@")) return;
    const old = this.connections.get("hubspot");
    if (!old || !usable(old)) to.store.adoptQueue("hubspot");
  }

  async push(runId: string, leads: Lead[]): Promise<SyncResult> {
    const groups = new Map<string, { sync: CrmSync; leads: Lead[] }>(), out: SyncResult["details"] = [];
    for (const lead of Array.isArray(leads) ? leads : []) {
      try {
        const c = this.connections.forClient(String(lead?.client_id ?? ""));
        let g = groups.get(c.key);
        if (!g) groups.set(c.key, (g = { sync: this.for(c), leads: [] }));
        g.leads.push(lead);
      } catch (e) {
        if (!(e instanceof NotConnected)) throw e;
        out.push(lead?.selected === true
          ? { lead_id: String(lead.lead_id), outcome: "error", message: scrub(e) }
          : { lead_id: String(lead?.lead_id ?? ""), outcome: "skipped", message: "not selected" });
      }
    }
    for (const { sync, leads } of groups.values()) {
      this.adoptUnsent(sync);
      out.push(...(await sync.push(runId, leads)).details);
    }
    return tally(out);
  }

  /** One polling pass over the connections that are due. */
  async poll(last: Map<string, number>, everyMs?: number): Promise<void> {
    for (const sync of this.active()) {
      const key = sync.store.crm;
      if (Date.now() - (last.get(key) ?? 0) < (everyMs ?? sync.adapter.pollMs)) continue;
      last.set(key, Date.now());
      try { this.adoptUnsent(sync); await pollOnce(sync); }
      catch (e) { console.error(`crm poll ${key}:`, scrub(e)); }
    }
  }
}

export async function pollOnce(sync: CrmSync): Promise<void> {
  await sync.pull();
  sync.refreshStatuses();
  if (sync.store.outbox().some(l => l.state === "pending" || l.state === "retry" || l.state === "in_flight")) await sync.drain();
}
