import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ledger } from "../ledger/ledger.js";
import { address, DAY_MS, operatorCap } from "./config.js";
import { checkDomain } from "./deliverability.js";
import type { Outreach } from "./engine.js";
import { googleClient, OAuthFlow } from "./google.js";
import { makeCall } from "./io.js";
import { SimMailbox } from "./simulate.js";

/*
 * The outreach API. Any UI can sit on it; the page at /outreach is a plain example.
 *   GET  /api/outreach                          everything a screen needs (see docs/outreach.md)
 *   GET  /api/outreach/health?domain=&selector= SPF, DKIM, DMARC for any domain
 *   GET  /api/outreach/connect                  starts Google sign-in
 *   POST /api/outreach/campaigns                {client_id, mailbox?, mode?, confirm_auto?, paused?, booking_url?, product_facts?}
 *   POST /api/outreach/mailboxes                {email, daily_cap?, dkim_selector?}  re-checks the domain
 *   POST /api/outreach/drafts/:id/approve       {hash}   the hash of the text the person read
 *   POST /api/outreach/drafts/:id/reject|send|check
 *   POST /api/outreach/conversations/:id/stop|booked
 *   POST /api/outreach/tick                     check replies and send what is due, now
 *   POST /api/outreach/alerts/status|telegram
 *   POST /api/outreach/sim/reply|advance        simulation only
 * POST bodies are application/json. Local requests only.
 */
class BadRequest extends Error {}
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
async function readBody(req: IncomingMessage): Promise<any> {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new BadRequest("Send application/json.");
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 100_000) throw new BadRequest("That request is too large.");
  }
  try { return (s && JSON.parse(s)) || {}; } catch { throw new BadRequest("That isn't valid JSON."); }
}

/** Returns false for paths that aren't outreach's, so a host server can fall through to its own routes. */
export function outreachRoutes(ledger: Ledger, engine: Outreach) {
  const oauth = new OAuthFlow();
  const callback = "/oauth/google/callback";
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (p !== "/outreach" && p !== callback && p !== "/api/outreach" && !p.startsWith("/api/outreach/")) return false;
    try {
      const host = req.headers.host ?? "", port = req.socket.localPort;
      const local = [`localhost:${port}`, `127.0.0.1:${port}`].includes(host) && (!req.headers.origin || req.headers.origin === `http://${host}`);
      if (!local) { json(res, 403, { error: "local requests only" }); return true; }
      await handle(req, res, url, host);
    } catch (err: any) {
      if (!res.headersSent) json(res, 400, { error: String(err?.message ?? err).slice(0, 300) });
      else res.end();
    }
    return true;
  };

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, host: string) {
    const p = url.pathname, s = engine.s;
    if (req.method === "GET") {
      if (p === "/outreach") {
        const nonce = randomBytes(16).toString("base64");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'self'`,
        });
        return res.end(readFileSync(new URL("./panel.html", import.meta.url), "utf8").replace("<script>", `<script nonce="${nonce}">`));
      }
      if (p === "/api/outreach") return json(res, 200, { ...engine.snapshot(), google_client: !engine.simulated && !!googleClient() });
      if (p === "/api/outreach/health")
        return json(res, 200, await checkDomain(url.searchParams.get("domain") ?? "", { selector: url.searchParams.get("selector"), call: makeCall(ledger, "outreach") }));
      if (p === "/api/outreach/connect") {
        if (engine.simulated) throw new BadRequest("Gmail connect is off in simulation.");
        res.writeHead(302, { location: oauth.start(`http://${host}${callback}`) });
        return res.end();
      }
      if (p === callback) {
        if (engine.simulated) throw new BadRequest("Gmail connect is off in simulation.");
        if (url.searchParams.get("error")) throw new BadRequest("Google sign-in was cancelled or refused.");
        const email = await oauth.finish(ledger, makeCall(ledger, "outreach"), url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
        await engine.checkMailbox(email);
        res.writeHead(302, { location: "/outreach", "referrer-policy": "no-referrer" });
        return res.end();
      }
      return json(res, 404, { error: "not found" });
    }
    if (req.method !== "POST") return json(res, 405, { error: "GET or POST" });
    const b = await readBody(req);
    let m: RegExpMatchArray | null;

    if (p === "/api/outreach/campaigns") {
      const id = String(b.client_id ?? "").trim();
      if (!id || id.length > 120) throw new BadRequest("client_id is required.");
      // validate everything before changing anything
      if (b.mode !== undefined && b.mode !== "approval" && b.mode !== "auto") throw new BadRequest("mode is approval or auto.");
      if (b.mode === "auto" && b.confirm_auto !== true) throw new BadRequest("Full auto sends without a click on each email. Confirm it with confirm_auto: true.");
      if (b.mailbox && !engine.usableMailboxes().some(x => x.email === b.mailbox)) throw new BadRequest("That mailbox isn't connected.");
      if (b.paused !== undefined && typeof b.paused !== "boolean") throw new BadRequest("paused is true or false.");
      if (b.booking_url && !/^https:\/\/[^\s<>"]{4,200}$/.test(b.booking_url)) throw new BadRequest("The booking link must be an https URL.");
      if (b.product_facts !== undefined && !Array.isArray(b.product_facts)) throw new BadRequest("product_facts is a list of sentences.");
      s.campaign(id);
      for (const [key, value] of Object.entries({
        mailbox: b.mailbox === undefined ? undefined : b.mailbox || null,
        mode: b.mode,
        paused: b.paused === undefined ? undefined : Number(b.paused),
        booking_url: b.booking_url === undefined ? undefined : b.booking_url || null,
      })) if (value !== undefined) s.run(`UPDATE outreach_campaigns SET ${key}=? WHERE client_id=?`, value, id);
      if (b.product_facts) engine.setFacts(id, b.product_facts);
      return json(res, 200, { ...s.campaign(id), product_facts: engine.facts(id) });
    }
    if (p === "/api/outreach/mailboxes") {
      const email = address(b.email);
      if (!email || !s.mailbox(email)) throw new BadRequest("That mailbox isn't connected.");
      const cap = b.daily_cap;
      if (cap !== undefined && cap !== null && !(Number.isInteger(cap) && cap >= 0 && cap <= operatorCap())) throw new BadRequest(`The cap is a whole number from 0 to ${operatorCap()}.`);
      const selector = b.dkim_selector === undefined ? undefined : String(b.dkim_selector ?? "").trim().toLowerCase();
      if (selector && !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(selector)) throw new BadRequest("That isn't a DKIM selector.");
      if (cap !== undefined) s.run("UPDATE outreach_mailboxes SET cap=? WHERE email=?", cap, email);
      if (selector !== undefined) s.run("UPDATE outreach_mailboxes SET dkim_selector=? WHERE email=?", selector || null, email);
      return json(res, 200, { health: await engine.checkMailbox(email), cap: engine.cap(email) });
    }
    if ((m = p.match(/^\/api\/outreach\/drafts\/([\w-]+)\/(approve|reject|send|check)$/))) {
      const [, id, verb] = m;
      if (verb === "send") return json(res, 200, await engine.execute(id));
      if (verb === "check") return json(res, 200, await engine.reconcile(id));
      if (verb === "approve") engine.approve(id, String(b.hash ?? "")); else engine.reject(id);
      return json(res, 200, ledger.getAction(id));
    }
    if ((m = p.match(/^\/api\/outreach\/conversations\/([\w-]+)\/(stop|booked)$/))) {
      if (!s.enrollmentById(m[1])) return json(res, 404, { error: "No such conversation." });
      if (m[2] === "booked") engine.markBooked(m[1]); else s.stop(m[1], "stopped by a person");
      return json(res, 200, s.enrollmentById(m[1]));
    }
    if (p === "/api/outreach/tick") return json(res, 200, await engine.tick());
    if (p === "/api/outreach/alerts/telegram") return json(res, 200, await engine.alerts.linkTelegram());
    if (p === "/api/outreach/alerts/status") {
      engine.alerts.raise(`status:manual:${randomBytes(6).toString("hex")}`, engine.statusText());
      await engine.alerts.flush();
      return json(res, 200, { ok: true });
    }
    if (engine.simulated && p === "/api/outreach/sim/advance") {
      const days = Number(b.days);
      if (!(days > 0 && days <= 60)) throw new BadRequest("days is 1 to 60.");
      s.set("sim_offset", String(Number(s.get("sim_offset") ?? 0) + days * DAY_MS));
      return json(res, 200, await engine.tick());
    }
    if (engine.simulated && p === "/api/outreach/sim/reply") {
      const e = s.enrollmentById(String(b.conversation_id ?? ""));
      if (!e) throw new BadRequest("No such conversation.");
      (engine.box(e.mailbox) as SimMailbox).receive(e.thread_id, b.bounce === true ? "mailer-daemon@simulated.invalid" : e.recipient, String(b.text ?? "").slice(0, 3000), `Re: ${e.subject}`);
      return json(res, 200, await engine.tick());
    }
    return json(res, 404, { error: "not found" });
  }
}

/** One pass a minute. The database lease keeps a second process from overlapping it. */
export function startWorker(engine: Outreach, everyMs = 60_000): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await engine.tick(); } catch (err: any) { console.error("outreach worker:", String(err?.message ?? err)); } finally { busy = false; }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
