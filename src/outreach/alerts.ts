import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Ledger } from "../ledger/ledger.js";
import { alertEmail, hasSecret, secretPath, testRecipients } from "./config.js";
import { HttpError, httpJson, makeCall } from "./io.js";
import type { Mailbox } from "./mail.js";
import { store } from "./store.js";

/** Outreach's own bot. Meridian's CRM bot token is never read: polling it would break the live bot. */
function botToken(): string | null {
  const env = process.env.TELEGRAM_OUTREACH_BOT_TOKEN;
  if (env) return env.trim();
  return hasSecret("telegram-token") ? readFileSync(secretPath("telegram-token"), "utf8").trim() || null : null;
}

export interface AlertState { telegram: "no_bot" | "not_linked" | "linked"; email: string | null }

export interface AlertChannel { name: "console" | "telegram" | "email"; ready: boolean; deliver(a: { key: string; text: string }): Promise<void> }

export class Alerts {
  constructor(private ledger: Ledger, private opts: {
    now: () => number;
    /** null in simulation, where nothing leaves the machine. */
    live: boolean;
    sender: () => Mailbox | null;
  }) {}
  private get s() { return store(this.ledger); }

  state(): AlertState {
    const email = alertEmail();
    return {
      telegram: !this.opts.live || !botToken() ? "no_bot" : this.s.get("telegram_chat") ? "linked" : "not_linked",
      email: this.opts.live && email && testRecipients().has(email) ? email : null,
    };
  }

  /** Durable first. One key alerts once per channel however often it is raised. */
  raise(key: string, text: string) {
    for (const channel of ["desk", "console", "telegram", "email"])
      this.s.run("INSERT OR IGNORE INTO outreach_alerts (key,channel,text,state,at) VALUES (?,?,?,?,?)", key, channel, text.slice(0, 1500), channel === "desk" ? "sent" : "pending", this.opts.now());
  }

  /** Every channel is optional except desk and console, which need no setup. Add one here and nothing else changes. */
  private channels(): AlertChannel[] {
    const state = this.state(), sender = state.email ? this.opts.sender() : null;
    return [
      { name: "console", ready: true, deliver: async a => { if (this.opts.live) console.log(`[outreach alert] ${a.text.replace(/\n/g, " | ")}`); } },
      { name: "telegram", ready: state.telegram === "linked", deliver: async a => { await this.telegram("sendMessage", { chat_id: this.s.get("telegram_chat"), text: a.text, link_preview_options: { is_disabled: true } }); } },
      { name: "email", ready: !!sender, deliver: async a => { await sender!.send({ to: state.email!, subject: `TradeScout: ${a.text.split("\n")[0].slice(0, 120)}`, body: a.text, key: `alert-${a.key}`, kind: "alert" }); } },
    ];
  }

  async flush() {
    for (const channel of this.channels()) {
      if (!channel.ready) continue; // waits in the table, so a bot linked later still gets it
      for (const a of this.s.all<{ key: string; text: string }>("SELECT key,text FROM outreach_alerts WHERE channel=? AND state='pending' AND attempts<10 ORDER BY at LIMIT 20", channel.name)) {
        // claim before the call, so two workers or a crash cannot send it twice
        if (!this.s.run("UPDATE outreach_alerts SET state='sending', attempts=attempts+1 WHERE key=? AND channel=? AND state='pending'", a.key, channel.name).changes) continue;
        try {
          await channel.deliver(a);
          this.s.run("UPDATE outreach_alerts SET state='sent', error=NULL WHERE key=? AND channel=?", a.key, channel.name);
        } catch (err: any) {
          // only a refusal is safe to repeat; an unanswered call may have been delivered
          const refused = err instanceof HttpError && err.status < 500 && err.status !== 408;
          this.s.run("UPDATE outreach_alerts SET state=?, error=? WHERE key=? AND channel=?", refused ? "pending" : "unknown", String(err?.message ?? err), a.key, channel.name);
        }
      }
    }
  }

  private async telegram(method: string, body: unknown): Promise<any> {
    const token = botToken();
    if (!token) throw new Error("No Telegram bot token yet.");
    const { data } = await makeCall(this.ledger, "outreach")({ source: "telegram", endpoint: method, request: { method }, cacheable: false }, () =>
      httpJson<any>("Telegram", `https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return data.result;
  }

  /** The chat is whoever sends the one-time code, so a stranger who finds the bot can't subscribe to leads. */
  async linkTelegram(): Promise<{ linked: boolean; url?: string }> {
    if (!this.opts.live) throw new Error("Telegram is off in simulation.");
    let code = this.s.get("telegram_code");
    const updates = await this.telegram("getUpdates", { timeout: 0 });
    const hit = code ? updates.find((u: any) => u.message?.text === `/start ${code}` && u.message.chat?.type === "private") : null;
    if (hit) {
      this.s.set("telegram_chat", String(hit.message.chat.id));
      this.s.set("telegram_code", randomBytes(8).toString("hex"));
      return { linked: true };
    }
    if (!code) this.s.set("telegram_code", (code = randomBytes(8).toString("hex")));
    const me = await this.telegram("getMe", {});
    return { linked: false, url: `https://t.me/${me.username}?start=${code}` };
  }
}
