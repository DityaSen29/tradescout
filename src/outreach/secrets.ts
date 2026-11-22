import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasSecret, secretDir, secretPath } from "./config.js";

/**
 * AES-256-GCM with a key file (0600) outside the database, so a database backup holds no usable token.
 * The mailbox is bound in as associated data: one mailbox's token cannot be pasted onto another row.
 */
function masterKey(): Buffer {
  if (!hasSecret("master.key")) {
    mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
    try { writeFileSync(secretPath("master.key"), randomBytes(32), { mode: 0o600, flag: "wx" }); }
    catch (err: any) { if (err?.code !== "EEXIST") throw err; }
  }
  const key = readFileSync(secretPath("master.key"));
  if (key.length !== 32) throw new Error("the outreach master key is damaged; reconnect the mailbox");
  return key;
}
export function seal(plain: string, owner: string, key = masterKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(owner));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}
export function open(sealed: string, owner: string, key = masterKey()): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("unreadable stored token; reconnect the mailbox");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
  d.setAAD(Buffer.from(owner));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
