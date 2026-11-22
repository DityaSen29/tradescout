import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { envLimit } from "../core/limits.js";
import { connectionView, conflictsView } from "./api.js";
import type { CrmSync } from "./engine.js";

/**
 * Mount before the server's own routing: `if (await crm(req, res)) return;`
 *   GET  /api/crm/connection                   connect status, last push and pull, calls against the cap
 *   POST /api/crm/connect                      check the key and create the Meridian fields
 *   POST /api/crm/sync                         push what is queued, pull what changed
 *   GET  /api/crm/leads                        sync state per lead, with stage, owner and amount from the CRM
 *   GET  /api/crm/conflicts                    open decisions, with their wording and choices
 *   POST /api/crm/conflicts/:id/approve|reject
 *   GET  /crm                                  a minimal panel until the product UI replaces it
 *   POST /api/crm/webhook/hubspot              signed requests only, for when an app replaces the service key
 */
export function createCrmRouter(sync: CrmSync, opts: { simulated?: boolean } = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = (req.url ?? "/").split("?")[0], method = req.method ?? "GET";
    if (path !== "/crm" && !path.startsWith("/api/crm/")) return false;
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); return true; };
    try {
      if (path === "/api/crm/webhook/hubspot" && method === "POST") {
        const secret = process.env.HUBSPOT_CLIENT_SECRET, uri = process.env.HUBSPOT_WEBHOOK_URL;
        if (!secret || !uri) return json(503, { error: "webhooks are not configured; polling is in use" });
        const body = await readRaw(req);
        if (!validSignature(secret, uri, body, req.headers["x-hubspot-signature-v3"], req.headers["x-hubspot-request-timestamp"])) return json(401, { error: "bad signature" });
        return json(200, sync.ingest(JSON.parse(body)));
      }
      // everything else is local only, like the desk's own approvals
      const host = req.headers.host ?? "", port = req.socket.localPort, origin = req.headers.origin;
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host) || (origin && origin !== `http://${host}`)) return json(403, { error: "local requests only" });

      if (path === "/crm" && method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "frame-ancestors 'self'" });
        res.end(readFileSync(new URL("./panel.html", import.meta.url)));
        return true;
      }
      if (method === "GET") {
        if (path === "/api/crm/connection") return json(200, connectionView(sync, opts));
        if (path === "/api/crm/leads") return json(200, { leads: sync.status().leads });
        if (path === "/api/crm/conflicts") return json(200, { conflicts: conflictsView(sync) });
      }
      if (method === "POST") {
        if (path === "/api/crm/connect") {
          const error = await sync.connect();
          return json(error ? 502 : 200, error ? { error } : connectionView(sync, opts));
        }
        if (path === "/api/crm/sync") {
          sync.store.requeueFailed();
          return json(200, await syncOnce(sync));
        }
        const m = path.match(/^\/api\/crm\/conflicts\/([\w-]+)\/(approve|reject)$/);
        if (m) {
          try { await sync.decide(m[1], m[2] === "approve" ? "approved" : "rejected"); }
          catch (e: any) { return json(409, { error: String(e?.message ?? e) }); }
          return json(200, await syncOnce(sync));
        }
      }
      return json(404, { error: "not found" });
    } catch (e: any) {
      return json(500, { error: String(e?.message ?? e).slice(0, 300) });
    }
  };
}

async function syncOnce(sync: CrmSync) {
  let error: string | null = null;
  try { await sync.drain(); } catch (e: any) { error = String(e?.message ?? e); }
  const pulled = await sync.pull();
  return { ...pulled, error: error ?? pulled.error };
}

/** Polling, the default inbound path. Call the returned function to stop. */
export function startPolling(sync: CrmSync, everyMs = envLimit("CRM_POLL_MS", 60_000)): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await sync.pull();
      if (sync.store.outbox().some(l => l.state === "pending" || l.state === "retry" || l.state === "in_flight")) await sync.drain();
    } catch (e: any) { console.error("crm poll:", e?.message ?? e); }
    finally { busy = false; }
  }, Math.max(5000, everyMs));
  timer.unref();
  return () => clearInterval(timer);
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
