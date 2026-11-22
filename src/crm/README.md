# CRM sync

Two-way sync of selected leads with **HubSpot**.

| CRM | State |
|---|---|
| HubSpot | Available. Tested on a simulator. Not yet run against a real account |
| Zoho | Coming soon. An adapter exists and is switched off. It has only met a simulator |
| Salesforce, Pipedrive | Coming soon. No code yet |

## Wire it in
```ts
import { crmFor, createCrmRouter, syncLeads } from "../crm/index.js";

const crm = createCrmRouter(crmFor(ledger));          // once, after the .env is loaded. It starts polling
if (await crm(req, res)) return;                      // first line inside the request handler

await syncLeads(ledger, runId, leads);                // { created, updated, skipped, errors, details }
crmFor(ledger).configured();                          // a key or sign-in is saved. Not proof that it works
```
Counts are per lead. `skipped` includes leads waiting for a person; `details[].outcome` says which (`review`). Say "connected" only when `GET /api/crm/connection` has `state: "connected"`.

## HTTP, for any UI
Every route takes `?connection=<key>`. Without it, the primary connection answers.

| Method and path | Returns |
|---|---|
| `GET /api/crm/connections` | `connections[]` without secrets, `primary` |
| `GET /api/crm/connection` | `state` (`no_key`, `unchecked`, `connected`, `error`), `account`, `error`, `last_push`, `last_pull`, `calls_today`, `queued`, `open_conflicts`, `paused`, `providers` (`available` or `coming_soon`), `simulated` |
| `POST /api/crm/connect` | checks the key and creates the fields; 502 with `error` if it fails |
| `GET /api/crm/oauth/start?provider=hubspot` | browser sign-in, once an app is saved |
| `POST /api/crm/sync` | pushes the queue and pulls changes: `applied`, `conflicts`, `error` |
| `GET /api/crm/leads` | `leads[]`: `lead_id`, `company`, `state`, `attempts`, `error`, `crm_fields` (`stage`, `owner`, `amount`) |
| `GET /api/crm/conflicts` | `conflicts[]`: `id`, `type`, `title`, `detail`, `choices.approve`, `choices.reject`, `needs_confirmation` |
| `POST /api/crm/conflicts/:id/approve` or `/reject` | applies that choice; 409 if the facts changed since they were shown |
| `GET /api/crm/paused` | `paused[]`: records a person stopped syncing |
| `POST /api/crm/paused/:lead/:kind/resume` | relinks the record, or recreates it if it is gone |

Times are epoch milliseconds. Requests must be local and same-origin. `/crm` is a throwaway minimal panel.

## Connect HubSpot
Use a key from Development > Keys > Service keys, with read and write on companies, contacts and deals for both `crm.objects` and `crm.schemas`. Save it either way:
```
HUBSPOT_TOKEN=...                                    # in the git-ignored .env, then restart the desk
npx tsx src/crm/connect.ts hubspot                   # hidden prompt, saved to ~/.tradescout/crm.json (0600)
npx tsx src/crm/connect.ts hubspot --client <id>     # a CRM of one client's own
npx tsx src/crm/connect.ts hubspot --oauth           # an app's id and secret, then browser sign-in
```
Turn off HubSpot's automatic company creation from email domains, or it creates its own duplicates.

## Rules
- **No duplicates:** company, contact and deal each carry `meridian_lead_id`, a unique field, looked up before every create. A company with the same domain or name, or a contact with the same email, waits for approval if someone else made it.
- **Outbox:** one row per lead holds the latest desired state. Network errors and 5xx retry with backoff, up to 6 attempts. Throttling waits without using them up. A crash resumes from the row.
- **Scale:** up to 50 leads are written at once through HubSpot's batch endpoints. A refused batch is retried row by row, so one bad row fails one lead.
- **Inbound:** polling reads property history every 60 s. Each change applies once, an older one never replaces a newer one, and the current value wins if history is cut short. Signed webhooks are accepted from an app; service keys cannot receive them.
- **Ownership:** we write company name and domain, contact name, title and work email, and deal name, match and draft status. A draft's new status follows on the next poll. The CRM owns stage, pipeline, owner and amount; we set only the first stage, on create.
- **A person decides:** deletes, merges, lookalike records, a changed decision-maker, and CRM edits to our fields. The token is never used to delete or merge. If 5 or more records vanish together, that is treated as an outage.
- **Clients:** once any client has its own connection, a client without one gets an error, never another client's CRM. Two clients cannot share an account.
- **Private by default:** claims, reasons, product, scores and customs behaviour are never sent. The call log holds no bodies, and secrets never enter the ledger.

## Limits
`CRM_RUN_CALL_LIMIT` (2,000) and `CRM_DAILY_CALL_LIMIT` (10,000, budget day in IST) are checked before each HTTP attempt. `CRM_POLL_MS` is 60,000; idle polling uses up to about 6,000 calls a day.

The module has its own gate instead of `ctx.call`, because sync runs outside pipeline steps and a memoised write or poll would be wrong. Calls are still logged in the run ledger.

## Demo
```
npx tsx src/crm/demo.ts            # simulated, no network
npx tsx src/crm/demo.ts --serve    # simulated, plus the panel on localhost:8790
npx tsx src/crm/demo.ts --live     # writes two DEMO leads to the connected HubSpot account
npx tsx src/crm/server.ts          # the real module, standalone
```

## Not proven
- Any call against a real HubSpot account. In particular: that account info is readable with these scopes, the batch response shapes, and that reading a merged record by its old id returns the survivor.
- HubSpot OAuth and webhooks against a real app.
- Workflows in the customer's HubSpot can react to the records we create. HubSpot's API has no switch to suppress them, so check for workflows that email new contacts before connecting a real account.
