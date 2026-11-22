import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
import { createServer } from "node:http";
import { Ledger } from "../ledger/ledger.js";
import { seedDemo, simulatedDns } from "./demo.js";
import { Outreach } from "./engine.js";
import { outreachRoutes, startWorker } from "./routes.js";

/**
 *   npx tsx src/outreach/server.ts              live: only OUTREACH_TEST_RECIPIENTS can be emailed
 *   npx tsx src/outreach/server.ts --simulate   separate database, example leads, no mail leaves the machine
 */
const simulate = process.argv.includes("--simulate");
const PORT = Number(process.env.OUTREACH_PORT ?? (simulate ? 8789 : 8788));
const ledger = simulate ? new Ledger(process.env.OUTREACH_SIM_DB ?? "data/outreach-sim.db") : new Ledger();
// simulated domains don't exist, so simulation checks them against example records
const engine = new Outreach(ledger, { simulate, txt: simulate ? simulatedDns : undefined });
if (simulate) {
  seedDemo(ledger, engine);
  for (const m of engine.usableMailboxes()) await engine.checkMailbox(m.email);
}
const handle = outreachRoutes(ledger, engine);
createServer(async (req, res) => {
  if (await handle(req, res)) return;
  if (req.url === "/") { res.writeHead(302, { location: "/outreach" }); return res.end(); }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`Outreach${simulate ? " (simulation, nothing is emailed)" : ""} on http://127.0.0.1:${PORT}/outreach`));
startWorker(engine);
