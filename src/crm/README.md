# CRM sync

Two-way sync for selected leads. HubSpot is implemented, Zoho is a stub behind the same interface.

## Wire it in
```ts
import { crmFor, createCrmRouter, startPolling, syncLeads } from "../crm/index.js";

const crm = createCrmRouter(crmFor(ledger));          // once, after the .env is loaded
if (await crm(req, res)) return;                      // first line inside the request handler
if (process.env.HUBSPOT_TOKEN) startPolling(crmFor(ledger));

await syncLeads(ledger, runId, leads);                // { created, updated, skipped, errors, details }
```
Counts are per lead. `skipped` includes leads waiting for a person; `details[].outcome` says which (`review`).

## HTTP, for any UI
| Method and path | Returns |
|---|---|
| `GET /api/crm/connection` | `state` (`no_key`, `unchecked`, `connected`, `error`), `account`, `error`, `last_push`, `last_pull`, `calls_today`, `queued`, `open_conflicts`, `simulated` |
| `POST /api/crm/connect` | checks the key and creates the fields; 502 with `error` if it fails |
| `POST /api/crm/sync` | pushes the queue and pulls changes: `applied`, `conflicts`, `error` |
| `GET /api/crm/leads` | `leads[]`: `lead_id`, `company`, `state`, `attempts`, `error`, `crm_owned` |
| `GET /api/crm/conflicts` | `conflicts[]`: `id`, `type`, `title`, `detail`, `choices.approve`, `choices.reject`, `needs_confirmation` |
| `POST /api/crm/conflicts/:id/approve` or `/reject` | applies that choice; 409 if the facts changed since they were shown |

Times are epoch milliseconds. Requests must be local and same-origin. `/crm` is a throwaway minimal panel.

## Rules
- **No duplicates:** company, contact and deal each carry `meridian_lead_id`, a unique field. Every write looks it up before creating. A same-domain company or same-email contact made by someone else waits for approval.
- **Outbox:** one row per lead holds the latest desired state. Network errors, 423, 429 and 5xx retry with backoff, up to 6 attempts. A crash resumes from the row.
- **Inbound:** polling reads property history every 60 s. Each change applies once and an older one never replaces a newer one. A signed webhook route exists for a later app, because service keys cannot receive webhooks.
- **Ownership:** we write company name and domain, contact name, title and work email, and deal name, match and draft status. The CRM owns stage, pipeline, owner and amount; we set only the first stage, on create. A CRM edit to our field waits for a person.
- **Deletes and merges:** never sent, and never applied without approval.
- **Private by default:** claims, reasons, product, scores and customs behaviour are never sent. The call log holds no bodies.

## Limits
`CRM_RUN_CALL_LIMIT` (500) and `CRM_DAILY_CALL_LIMIT` (10,000, budget day in IST) are checked before each HTTP attempt. `CRM_POLL_MS` is 60,000; idle polling uses up to about 6,000 calls a day.

The module has its own gate instead of `ctx.call`, because sync runs outside pipeline steps and a memoised write or poll would be wrong. Calls are still logged in the run ledger.

## Key
HubSpot: Development > Keys > Service keys, with read and write on companies, contacts and deals, for both `crm.objects` and `crm.schemas`. Put it in the git-ignored `.env` as `HUBSPOT_TOKEN`. Turn off HubSpot's automatic company creation from email domains, or it creates its own duplicates.

## Demo
```
npx tsx src/crm/demo.ts            # simulated, no network
npx tsx src/crm/demo.ts --serve    # simulated, plus the panel on localhost:8788
npx tsx src/crm/demo.ts --live     # writes two DEMO leads to the HubSpot account behind the key
npx tsx src/crm/server.ts          # the real module, standalone
```

## Not done
Zoho calls, OAuth and a second CRM account per database, batch writes (a lead costs about 12 calls on create), history older than HubSpot returns, and restoring an accepted delete.
