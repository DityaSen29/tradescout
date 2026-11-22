# TradeScout: context for a new session

Paste this into a fresh Claude session, or point it at this file. Everything below is true as of 22 Nov 2026, 13:40 IST.

## Where you are
- Repo: /Users/jeevanmohapatra/Projects/tradescout, public at https://github.com/Jeevannnn20/tradescout. Owner: Jeevan Mohapatra (GitHub Jeevannnn20), a BITS Pilani student. Git identity is configured; commit with plain `git commit`, never pass an email on the command line.
- Event: ContextCon 05 hackathon, Crustdata x Y Combinator, BITS Pilani. Theme "Services, Replaced": build an agent that does a whole paid job end to end on live data, every claim sourced, a person approves anything irreversible. Build runs 10:15 to 18:00 IST today; code freeze 18:00; checkpoint submission at 14:30; finalists 19:30; finals 19:45 (demo, a kill-and-restart on stage, a live fix, questions on scale). Finals rubric: live run 20, robustness 15, design 15, ethics 25, finance 25. Organizers said the theme is not compulsory. Rules: no code from before 10:15, agents never contact real people, no stored results or faked demos, commit continuously, declare pre-build designs on the form. Read docs/submission.md for the form answers and `~/Projects/contextcon-notes/` for the research done before the build.
- Secrets: `.env` holds CRUSTDATA_API_KEY (event key, 15,000 credits, 5 requests/min per endpoint). Never print it. Enabled endpoints: company search/enrich/identify, person search/enrich, job search, web search; contact enrich, live and batch endpoints are disabled.

## What we are building and for whom
TradeScout is an export sourcing desk. The user is an export manager at a 50 to 500 person Indian manufacturer deciding which foreign market to enter and which distributors or importers to pitch. Today that costs a consultant study (₹50k to ₹5L, weeks), a trade-data subscription, and a buyer credit report per counterparty. TradeScout takes product and target market and returns: a Comtrade market signal, the WITS duty picture, dated policy news, a ranked shortlist of real counterparties with a deterministic trust tier, the right buyer at each, and a drafted first email that waits for approval. Nothing is ever sent. Price idea: ₹1,500 per market report; measured cost per run 29.2 Crustdata credits (about ₹25).

## What is built (all working, committed, pushed, 30 tests passing)
- Stack: Node 26, TypeScript via tsx, zod, vitest, Node's built-in sqlite (no native deps), plain node:http API on :8787, vanilla HTML/JS UI in public/. No LLM calls anywhere: parsing, scoring, trust and drafts are rules.
- Pipeline (src/pipeline.ts): parse → market → tariff → policy → search → vet → intent → contacts → draft → report. Each step is a checkpoint; optional layers return unavailable/cannot_verify instead of failing.
- Ledger (src/ledger/ledger.ts): runs with time and credit ceilings, steps, calls (cost ledger + per-run memo by request hash), evidence, actions (idempotency keys, guarded approve→executing→executed), snapshots for the "since last run" diff.
- CLI (src/cli.ts): run, resume, retry --from <step>, ledger, runs, check, approve/reject/execute, --hs <code> for the person's HS pick.
- API (src/api/server.ts): POST /api/runs, GET /api/runs/:id, SSE /api/runs/:id/events, resume, retry, ledger, evidence, graph, record viewer (/api/runs/:id/record?endpoint=&id=&field=), action approve/reject/execute. Static UI at /.
- Semantics (src/semantics/): HS resolver over UN HS 2022 (data/raw/H6.json), country resolver over UN partner areas, curated product families (synonyms.ts). HS near-ties stop the run and ask; request.hs_code resolves it.
- Scoring (src/scoring/): fit rules, trust tier (missing data is AMBER, never GREEN; name-only sanctions match is AMBER + needs a person), intent from job postings, rank over an in-memory context graph (src/graph/model.ts). Neo4j was removed on purpose; do not add it back.
- Sources: Crustdata REST (src/sources/crustdata.ts, with field-name gotchas encoded), UN Comtrade public preview (one period per call, 2.2 s pacing), WITS tradestats-tariff (sector level, EU reporter for EU members), OFAC SDN + UN list local name screen, Crustdata web search for policy news (only dated items set the flag).
- Verified live: "industrial textiles" + "in Germany" with hs_code 5911 → 25 companies, 5 GREEN, 4 buyers, 5 drafts, 29.2 credits, run id 41ef4ac4-0e6b-4cb1-abe6-fd41ff854d31. Kill and resume reuses checkpoints and pays nothing twice for kills between calls.
- Docs: README.md (all required sections, including a disclosure that sqlite side files and one draft were briefly committed), docs/architecture.md (Mermaid), docs/test-cases.md, docs/submission.md.

## Known gaps and conventions
- Tariff is sector level, not HS line level. Policy news is often undated; undated items go to "needs a person". Contacts are one search per batch, 15 profiles; big companies can crowd out small ones.
- Mock data only in tests (tests/fixtures/crustdata.ts stubs fetch). Never pre-seed caches or present cached output as live.
- Every new external call goes through ctx.call so it lands in the ledger with credits and latency. Every claim needs an Evidence object with source_url, record id/field, record_date where the source has one, retrieved_at.
- Keep personal data minimal: name, title, employer. data/, *.db*, .env are git-ignored.
- Demo video is paused by the user; do not record one until asked.
- Start the API with `PORT=8787 npx tsx src/api/server.ts` (restart after code changes). Run tests with `npm test`.

## Immediate next steps
1. Submit the checkpoint form at 14:30 with docs/submission.md.
2. Rehearse kill-and-restart through the UI (kill the server mid-run, restart, press Resume).
3. A second product/market live run to check generalisation (about 30 credits).
4. Pitch and design-question prep: scale (queue + Postgres with the same schema), second client, why rules over an LLM, what breaks first (5 RPM key).
5. Final submission before 18:00 with the demo video when the user lifts the pause.
