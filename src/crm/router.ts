import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { envLimit } from "../core/limits.js";
import { KINDS, scrub, type Kind } from "./adapter.js";
import { connectionView, conflictsView } from "./api.js";
import { keyOf, usable, type Provider } from "./credentials.js";
import { CrmSync } from "./engine.js";
import { pollOnce, type CrmHub } from "./hub.js";
import { sameSecret } from "./oauth.js";

/**
 * Mount before the server's own routing: `if (await crm(req, res)) return;`
 * Given the hub from crmFor(), it also starts polling. Every route below takes `?connection=<key>`.
 *   GET  /api/crm/connections                  every connection, without secrets
 *   GET  /api/crm/connection                   connect status, last push and pull, usage against the cap
 *   POST /api/crm/connect                      check the key and create the Meridian fields
 *   GET  /api/crm/oauth/start?provider=        browser sign-in for HubSpot or Zoho (&client= for one client)
 *   POST /api/crm/sync                         push what is queued, pull what changed
 *   GET  /api/crm/leads                        sync state per lead, with stage, owner and amount from the CRM
 *   GET  /api/crm/conflicts                    open decisions, with their wording and choices
 *   POST /api/crm/conflicts/:id/approve|reject
 *   GET  /api/crm/paused                       records whose sync a person stopped
 *   POST /api/crm/paused/:lead/:kind/resume    undo that
 *   GET  /crm                                  a minimal panel until the product UI replaces it
 *   POST /api/crm/webhook/hubspot|zoho         verified requests only
 */
export function createCrmRouter(target: CrmSync | CrmHub, opts: { simulated?: boolean } = {}) {
  const hub = target instanceof CrmSync ? null : target;
  const one = target instanceof CrmSync ? target : null;
  if (hub) startPolling(hub);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://local"), path = url.pathname, method = req.method ?? "GET";
    if (path !== "/crm" && !path.startsWith("/api/crm/")) return false;
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
    try {
      if (path === "/api/crm/webhook/hubspot" && method === "POST") return await hubspotWebhook(req, json, hub, one);
      if (path === "/api/crm/webhook/zoho" && method === "POST") return await zohoWebhook(req, json, hub);

      // everything else is local only, like the desk's own approvals
      const host = req.headers.host ?? "", port = req.socket.localPort, origin = req.headers.origin;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host) || (origin && origin !== `http://${host}`)) return json(403, { error: "local requests only" });
      const q = url.searchParams;

      if (method === "GET") {
        if (path === "/crm") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "frame-ancestors 'self'" });
          res.end(readFileSync(new URL("./panel.html", import.meta.url)));
          return true;
        }
        if (path === "/api/crm/connections") {
          const connections = hub ? hub.describe() : [{ key: one!.store.crm, provider: one!.adapter.name, client: "*", ready: true, auth: "key" }];
          return json(200, { connections, primary: hub ? hub.connections.primary()?.key ?? null : one!.store.crm });
        }
        if (hub && path === "/api/crm/oauth/start") {
          const provider = q.get("provider") ?? "";
          if (provider !== "hubspot" && provider !== "zoho") return json(400, { error: "provider must be hubspot or zoho" });
          if (!hub.connections.offered.includes(provider)) return json(400, { error: `${provider} is coming soon` });
          let to: string;
          try { to = hub.oauth.start(keyOf(provider as Provider, q.get("client") || "*"), `http://${host}`); }
          catch (e) { return json(400, { error: scrub(e) }); }
          res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" });
          res.end();
          return true;
        }
        if (hub && path === "/api/crm/oauth/callback") {
          let key: string;
          try { key = (await hub.oauth.finish(q)).key; } catch (e) { return json(400, { error: scrub(e) }); }
          void hub.pick(key)?.connect();
          // the code leaves the address bar at once
          res.writeHead(302, { location: `/crm?connection=${encodeURIComponent(key)}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
          res.end();
          return true;
        }
      }

      const sync = hub ? hub.pick(q.get("connection")) : one!;
      if (!sync) return json(404, { error: "no such connection" });

      if (method === "GET") {
        if (path === "/api/crm/connection") return json(200, connectionView(sync, { ...opts, hub: hub ?? undefined }));
        if (path === "/api/crm/leads") return json(200, { leads: sync.status().leads });
        if (path === "/api/crm/conflicts") return json(200, { conflicts: conflictsView(sync) });
        if (path === "/api/crm/paused") return json(200, { paused: sync.store.paused() });
      }
      if (method === "POST") {
        if (path === "/api/crm/connect") {
          const error = await sync.connect();
          return json(error ? 502 : 200, error ? { error } : connectionView(sync, { ...opts, hub: hub ?? undefined }));
        }
        if (path === "/api/crm/sync") {
          sync.store.requeueFailed();
          return json(200, await syncOnce(sync));
        }
        let m = path.match(/^\/api\/crm\/conflicts\/([\w-]+)\/(approve|reject)$/);
        if (m) {
          try { await sync.decide(m[1], m[2] === "approve" ? "approved" : "rejected"); }
          catch (e) { return json(409, { error: scrub(e) }); }
          return json(200, await syncOnce(sync));
        }
        m = path.match(/^\/api\/crm\/paused\/([^/]+)\/(\w+)\/resume$/);
        if (m && KINDS.includes(m[2] as Kind)) {
          let result: string;
          try { result = await sync.resume(decodeURIComponent(m[1]), m[2] as Kind); }
          catch (e) { return json(409, { error: scrub(e) }); }
          return json(200, { result, ...(await syncOnce(sync)) });
        }
      }
      return json(404, { error: "not found" });
    } catch (e) {
      return json(500, { error: scrub(e) });
    }
  };
}

type Reply = (code: number, body: unknown) => boolean;

async function hubspotWebhook(req: IncomingMessage, json: Reply, hub: CrmHub | null, one: CrmSync | null): Promise<boolean> {
  const uri = process.env.HUBSPOT_WEBHOOK_URL;
  const apps = hub ? hub.connections.list().filter(c => c.provider === "hubspot") : [];
  const secrets = [process.env.HUBSPOT_CLIENT_SECRET, ...apps.map(c => c.app_secret)].filter((s): s is string => !!s);
  if (!uri || !secrets.length) return json(503, { error: "webhooks are not configured; polling is in use" });
  const body = await readRaw(req), signature = req.headers["x-hubspot-signature-v3"], at = req.headers["x-hubspot-request-timestamp"];
  const signedBy = secrets.filter(s => validSignature(s, uri, body, signature, at));
  if (!signedBy.length) return json(401, { error: "bad signature" });
  let events: unknown;
  try { events = JSON.parse(body); } catch { return json(400, { error: "expected JSON" }); }
  if (!Array.isArray(events)) return json(400, { error: "expected a list of events" });
  if (one) return json(200, one.ingest(events));
  let applied = 0, review = 0;
  for (const c of apps) {
    const secret = c.app_secret ?? process.env.HUBSPOT_CLIENT_SECRET;
    // one client's app cannot speak for another client's account
    if (!usable(c) || !secret || !signedBy.includes(secret)) continue;
    const r = hub!.for(c).ingest(events.filter(e => e?.portalId !== undefined));
    applied += r.applied; review += r.review;
  }
  return json(200, { applied, review });
}

const waking = new WeakSet<CrmSync>();
async function zohoWebhook(req: IncomingMessage, json: Reply, hub: CrmHub | null): Promise<boolean> {
  if (!hub) return json(503, { error: "notifications are not configured; polling is in use" });
  let token: unknown;
  try { token = JSON.parse(await readRaw(req))?.token; } catch { return json(400, { error: "expected JSON" }); }
  const c = hub.connections.list().find(x => x.provider === "zoho" && sameSecret(x.hook_secret, token));
  if (!c) return json(401, { error: "bad token" });
  // a notification carries no trusted values: it only brings the next pull forward
  const sync = hub.for(c);
  if (!waking.has(sync)) {
    waking.add(sync);
    setTimeout(() => {
      waking.delete(sync);
      pollOnce(sync).catch(e => console.error("crm notification:", scrub(e)));
    }, 2000).unref();
  }
  return json(200, { received: true });
}

async function syncOnce(sync: CrmSync) {
  let error: string | null = null;
  sync.refreshStatuses();
  try { await sync.drain(); } catch (e) { error = scrub(e); }
  const pulled = await sync.pull();
  return { ...pulled, error: error ?? pulled.error };
}

const pollers = new WeakMap<object, () => void>();
/** Polling, the default inbound path. Safe to call twice. Call the returned function to stop. */
export function startPolling(target: CrmSync | CrmHub, everyMs?: number): () => void {
  const running = pollers.get(target);
  if (running) return running;
  const fixed = everyMs ?? (process.env.CRM_POLL_MS ? envLimit("CRM_POLL_MS", 60_000) : undefined);
  const last = new Map<string, number>();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (target instanceof CrmSync) await pollOnce(target);
      else await target.poll(last, fixed === undefined ? undefined : Math.max(5000, fixed));
    } catch (e) { console.error("crm poll:", scrub(e)); }
    finally { busy = false; }
  }, target instanceof CrmSync ? Math.max(5000, fixed ?? target.adapter.pollMs) : 5000);
  timer.unref();
  const stop = () => { clearInterval(timer); pollers.delete(target); };
  pollers.set(target, stop);
  return stop;
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 1_000_000) { reject(new Error("body too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

const DECODE = /%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi;
export function validSignature(secret: string, uri: string, body: string, signature: unknown, timestamp: unknown, now = Date.now()): boolean {
  if (typeof signature !== "string" || typeof timestamp !== "string" || !(Math.abs(now - Number(timestamp)) <= 300_000)) return false;
  const decoded = uri.replace(DECODE, s => decodeURIComponent(s));
  const want = Buffer.from(createHmac("sha256", secret).update(`POST${decoded}${body}${timestamp}`).digest("base64"));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}
