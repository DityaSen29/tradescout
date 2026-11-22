import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Ledger } from "../ledger/ledger.js";
import type { CrmSync } from "./engine.js";
import type { CrmHub } from "./hub.js";
import { createCrmRouter } from "./router.js";
import { crmFor } from "./index.js";

/** The panel on its own, until the desk mounts the router. */
export function serveCrm(sync: CrmSync | CrmHub, opts: { port?: number; simulated?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.CRM_PORT ?? 8788), route = createCrmRouter(sync, opts);
  const server = createServer(async (req, res) => {
    if (await route(req, res)) return;
    res.writeHead(302, { location: "/crm" }); res.end();
  });
  server.listen(port, "127.0.0.1", () => console.log(`CRM panel on http://localhost:${port}/crm`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const sync = crmFor(new Ledger());   // the router polls
  serveCrm(sync);
  for (const connection of sync.active()) void connection.connect();
}
