# Buyer desk API

Base: `http://localhost:8787`. Local only: another Host or Origin gets 403, so a separate frontend dev server must proxy `/api`. Types are in `src/buyer/contract.ts`.

## Start: `npm run setup && npm run api`

Needs `CRUSTDATA_API_KEY` and `GEMINI_API_KEY` in `.env`. Export files are optional: `python3 -I scripts/import-exports.py file.xlsx ...`.

## Flow

| Call | Body | Returns |
|---|---|---|
| `POST /api/runs` | `{product, target_country, client_name?, origin_country?, hs_code?, notes?, do_not_contact?: string[], min_headcount?, max_headcount?, client_id?}` | `{run_id}` |
| `GET /api/runs/:id/events` | | SSE, below |
| `GET /api/runs/:id` | | `{run, running, steps, totals, coverage, calls, trust (by lead_id: label, reason, record_dates, retrieved_at), plan, trace, shortlist: Lead[], max_selected, actions, report}` |
| `POST /api/runs/:id/select` | `{lead_ids: string[]}`, 1 to 5 | resumes the run: contacts, emails, drafts |
| `POST /api/actions/:id/approve`, `/reject` | | the action |
| `POST /api/actions/:id/execute` | | once: writes to the test outbox, or emails a listed team inbox when `OUTREACH_TEST_RECIPIENTS` is set. `{ran, reason?}` |
| `POST /api/runs/:id/sync` | | queues and pushes the selected leads to the CRM |
| `POST /api/runs/:id/resume`, `/retry` | retry: `{from}` | continues from checkpoints |
| `GET /api/runs/:id/ledger`, `/evidence` | | every call and cost, every claim |
| `GET /api/runs` | | recent runs |
| `POST /api/actions/:id/edit` | `{subject, text, draft_hash}`; text has no greeting or sign-off | re-runs both gates. `{ok, draft_hash}` or 422 `{problems}`. Voids approval |
| `POST /api/actions/batch-approve` | `{items: [{id, draft_hash}]}` | `{results: [{id, ok, reason?}]}`. Safe to repeat |
| `POST /api/actions/:id/undo` | | back to proposed, only if nothing was executed |
| `POST /api/actions/:id/reject` | `{reason?}` | the action |
| `GET`, `POST /api/pause` | `{paused}` | pause-all: no executor can act while paused |
| `GET /api/modules` | | modules with status, pipeline stages, outreach mode |
| `GET /api/limits` | | today's spend against the caps |
| `/api/crm/*` | | see `src/crm/README.md` |
| `/api/outreach/*` | | see `docs/outreach.md` |

`run.status`: `running`, `awaiting_person` (show the selection), `done`, `failed`, `budget_exceeded`.

Steps: `plan`, `customs`, `research`, `shortlist`, `select`, `contacts`, `write`, `report`.

`GET /api/runs/:id` also has `step_costs` (rupees and share per step), `failure` (`{type, step, message, resumable}`) and `paused_all`. Leads from customs carry `origin_share`.

## Events

Each has `seq` and `at`. History replays on connect. After `done` or `error` the stream closes; open it again after a select or resume.

| Event | Fields |
|---|---|
| `agent` | `agent` (planner, customs, researcher, critic, orchestrator, policy, enrichment, copywriter), `message` |
| `step` | `name`, `status` (start, done, skip, waiting, fail, unavailable), `info` |
| `log` | `message` |
| `done` | `status` (the run status) |
| `error` | `message` |

After a server restart the live history is gone. `trace` on `GET /api/runs/:id` has it.

## Rules a frontend must keep

- `plan.seller_origin` is `{iso3, name, source, quote}`. `source` is `request` (the field), `prompt` (read from the brief, with the quote) or `default` (assumed for ranking only, so don't present it as the seller's origin).

- `import_record` is the only label that may say "imports". `product_match` means evidence of product use, with no import proof.
- `behaviour` and claims with `shareable: false` are internal to the seller. Never show them in buyer-facing text.
- Buyer intelligence (`coming_next`) is Feature 2: show it locked. Only the evidence figures (records, volume, value, price) are part of the shortlist.
- Render all model, web and company text as text, never as HTML.
- `totals.estimated_inr` is an estimate. Label it "about".
