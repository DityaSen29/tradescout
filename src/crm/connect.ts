/**
 * Save a CRM connection on this Mac. Secrets are typed at hidden prompts, never passed as arguments or pasted in chat.
 *   npx tsx src/crm/connect.ts hubspot               a service key
 *   npx tsx src/crm/connect.ts hubspot --oauth       an app's id and secret, then sign in in the browser
 *   npx tsx src/crm/connect.ts zoho --dc in          a Self Client's id, secret and code
 *   add --client <client_id> to give one client a CRM of its own
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { scrub } from "./adapter.js";
import { Connections, keyOf, zohoAccounts } from "./credentials.js";
import { exchangeCode, ZOHO_SCOPES } from "./oauth.js";

function hidden(question: string): Promise<string> {
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _enc, done) => done() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise(resolve => rl.question("", answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()); }));
}
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const provider = args[0];
  if (provider !== "hubspot" && provider !== "zoho") throw new Error("usage: connect.ts hubspot|zoho [--client <id>] [--oauth] [--dc in|com|eu|au|jp|sa|ca|cn]");
  if (!process.stdin.isTTY) throw new Error("run this in a Terminal, so the secrets stay hidden");
  if (existsSync(".env")) process.loadEnvFile(".env");
  const client = option("client") ?? "*", key = keyOf(provider, client), saved = new Connections();
  const start = `http://localhost:${process.env.PORT ?? 8787}/api/crm/oauth/start?provider=${provider}${client === "*" ? "" : `&client=${encodeURIComponent(client)}`}`;

  if (provider === "hubspot" && !args.includes("--oauth")) {
    const token = await hidden("HubSpot service key (hidden): ");
    if (!token) throw new Error("nothing entered; nothing saved");
    saved.save(key, { provider, client, token });
    console.log(`Saved ${key}. Open the desk's /crm page and press Sync now.`);
    return;
  }

  const accounts_url = provider === "zoho" ? zohoAccounts(option("dc") ?? process.env.ZOHO_DC ?? "in") : undefined;
  if (provider === "zoho") console.log(`Zoho data centre: ${accounts_url}\nWhen generating the Self Client code, paste these scopes:\n${ZOHO_SCOPES.join(",")}\n`);
  const app_id = await hidden("Client ID (hidden): "), app_secret = await hidden("Client secret (hidden): ");
  if (!app_id || !app_secret) throw new Error("both are needed; nothing saved");
  const c = saved.save(key, { provider, client, app_id, app_secret, accounts_url, token: undefined, refresh_token: undefined, access_token: undefined });
  const code = provider === "zoho" ? await hidden("Self Client code (hidden; press Return to sign in by browser instead): ") : "";
  if (code) {
    await exchangeCode(saved, c, code);
    console.log(`Connected ${key}. Open the desk's /crm page and press Sync now.`);
  } else console.log(`Saved ${key}. With the desk running, open ${start}`);
}
main().catch(e => { console.error(scrub(e)); process.exit(1); });
