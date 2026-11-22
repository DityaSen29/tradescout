import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envLimit } from "../core/limits.js";

export const DAY_MS = 86_400_000;
/** Days after the first email. A late step pushes the next one back, so two never go out together. */
export const FOLLOW_UP_DAYS = [3, 7, 14] as const;
export const OPT_OUT = "If this isn't relevant, reply STOP and I won't write again.";

/** Secrets live outside the repo and outside the database. */
export const secretDir = () => process.env.OUTREACH_HOME ?? join(homedir(), ".tradescout");
export const secretPath = (name: string) => join(secretDir(), name);
export const hasSecret = (name: string) => existsSync(secretPath(name));

const EMAIL = /^[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
/** One plain address, lower-cased. Anything usable for header or search injection is null. */
export function address(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return EMAIL.test(s) ? s : null;
}
export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/**
 * Exact addresses that may receive mail. Empty means nothing sends, and there is deliberately
 * no wildcard and no switch that turns this off.
 */
export function testRecipients(): Set<string> {
  return new Set((process.env.OUTREACH_TEST_RECIPIENTS ?? "").split(",").map(address).filter((a): a is string => !!a));
}
export const alertEmail = () => address(process.env.OUTREACH_ALERT_EMAIL);
export const operatorCap = () => envLimit("OUTREACH_MAILBOX_DAILY_CAP", 40);
