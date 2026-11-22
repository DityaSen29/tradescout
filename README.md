# TradeScout

An export sourcing desk, built in one day at ContextCon 05 (Crustdata × Y Combinator, BITS Pilani, 22 November 2026).

Product and target market in. Out: a cited market signal, the duty and policy picture, a shortlist of real counterparties with a deterministic trust tier, the right buyer at each, and a drafted first email that waits for a person's approval. Every claim links to the record behind it with its date, or says "cannot verify" and names what is missing.

## The service

**The job.** Before an Indian manufacturer ships to a new country it needs three answers: is the market worth it, which distributors or importers there are real and solvent, and who at each one actually buys. Today an export consultant or a market-entry study delivers that in two to three weeks for ₹50,000 to ₹5 lakh, a trade-data subscription such as Volza or Panjiva costs $59 to $500 a month for the shipment side, and a credit-insurer or bureau buyer report costs ₹2,000 to ₹10,000 per counterparty and arrives in days. All three are stale on arrival.

**Who pays.** The export manager or owner of a 50 to 500 person manufacturer. Secondary buyers: export promotion councils, 3PL and freight forwarders opening a new lane, and trade-credit insurers screening buyers.

**The price we would charge.** ₹1,500 per market report, or ₹9,000 a month for up to ten markets with monitoring. **What one job costs us to run:** 29.2 Crustdata credits measured on the live run (about ₹25 at list price, where 15,000 credits cost roughly ₹12,500) plus free public data; no model calls in the current build. That is well under ₹100 per run, so the margin funds the human review desk for "needs a person" items.

## What it does now

End to end, on a request it has never seen:

1. **Read the request.** Product text → HS code (UN HS 2022 reference, fuzzy), country → ISO3 (UN partner list), a keyword map in the language distributors use. Vague product → up to three HS candidates are listed as a question. Unknown country → "cannot verify", run stops, nothing is paid.
2. **Market.** UN Comtrade: imports of the HS code into the target country, last three reported years, world and from India; share and growth.
3. **Duty.** World Bank WITS: simple-average applied tariff the market charges on Indian goods in the product's sector, against MFN; EU members read as the EU. Sector level, and the report says so.
4. **Policy.** Crustdata web search (news): dated items on import policy for this product and market; only dated items set the flag; undated mentions go to a person.
5. **Find counterparties.** One Crustdata company search in the target country and headcount band with a hybrid query; widened once on zero results. Fit score by rules. Duplicates (same domain) merged with both ids shown; lookalike names flagged, never merged.
6. **Vet.** One Crustdata enrich for the top five; local sanctions screen (OFAC SDN, UN consolidated); adverse-news count; a deterministic trust tier where missing data is AMBER, never GREEN.
7. **Buying signals.** Crustdata job search: open buying or sourcing roles and headcount growth.
8. **Find the buyer.** Crustdata person search for procurement, purchasing, sourcing or management titles at vetted companies. Name, title and employer only; no emails, phones or profile enrichment.
9. **Draft.** A first email per buyer, as a proposed action. Nothing is sent. A person approves or rejects; an approved draft is written once to a file for the person to send.
10. **Report.** Ranked over a context graph (fit, graph neighbourhood, intent, trust), every row with its sources, a "needs a person" list, limitations, the cost ledger, and a diff against the previous run of the same request.

**Where it still needs a person.** Choosing among HS candidates when the product is vague; the undated policy mentions; any counterparty with no enrichment record; approving every draft; sending anything.

## What it could do in the future

Line-level tariffs and rules of origin once a reliable HS6 tariff source is wired; shipment-record evidence (who already imports from India) from a customs-data provider; a watcher that re-runs the request weekly and alerts on tier changes; an LLM for parsing messy requests and polishing drafts, kept behind the same evidence contract. Not now: each adds a source whose failure modes we could not test today, and the rubric rewards a correct run over a wide one.

## The future of this service

Once agents can do the whole job, the market-entry study, the buyer screen and the first outreach collapse into one desk that runs every week per market, charges per market instead of per report, and hands people only the exceptions: an ambiguous product, an undated policy signal, a counterparty with thin records, and the decision to send.

## How to run it

Node 22.5 or newer (built on Node 26). No native dependencies; the ledger is Node's built-in sqlite.

```bash
git clone https://github.com/Jeevannnn20/tradescout && cd tradescout
npm install
cp .env.example .env            # add CRUSTDATA_API_KEY; the rest is optional
npm test                        # 25 tests, offline, stubbed Crustdata
npm run run -- --product "industrial textiles" --country Germany
npm run api                     # http://localhost:8787  (desk UI + API)
```

Other commands:

```bash
npx tsx src/cli.ts check                      # credits and which endpoints this key can call (free)
npx tsx src/cli.ts resume <run-id>            # continue a killed run; each action happens once
npx tsx src/cli.ts retry <run-id> --from vet  # re-run from a step; memoised calls are free
npx tsx src/cli.ts ledger <run-id>            # every call, cost, latency; every action
npx tsx src/cli.ts approve|reject|execute <action-id>
TRADESCOUT_KILL_DURING=contacts npm run run -- --product "basmati rice" --country UAE   # simulate a crash
```

Per-run ceilings: `RUN_TIME_LIMIT_MS` (default 240 s of active time per attempt) and `RUN_CREDIT_LIMIT` (default 150 credits).

## Hard API limits

| Provider | Per run | Per day (IST) | Variables |
|---|---|---|---|
| Crustdata | 150 credits | 1,500 credits | `RUN_CREDIT_LIMIT`, `CRUSTDATA_DAILY_LIMIT` |
| Apollo | 25 credits | 100 credits | `APOLLO_RUN_LIMIT`, `APOLLO_DAILY_LIMIT` |
| LLM | $0.50 | $3 | `LLM_RUN_LIMIT_USD`, `LLM_DAILY_LIMIT_USD` |

- Each paid call holds its worst-case cost before it starts and settles to the reported charge afterwards. A call that would cross either limit is never made.
- A timeout, 5xx, malformed 200 or crash keeps its hold, because the charge is unknown. A paid call with no stated maximum, or an unclassified source, is refused.
- The limits cover calls this app makes through `ctx.call`, counted in its own ledger. Apollo and LLM have no caller yet. Use of the Apollo connector or the same keys elsewhere is not counted.
- `npx tsx src/cli.ts limits` shows today's use.
- An action with an unknown outcome is never retried. Check it, then run `npx tsx src/cli.ts reconcile <action-id> done|not-done`.

## How it's built

Diagram: [docs/architecture.md](docs/architecture.md). Test cases: [docs/test-cases.md](docs/test-cases.md).

- **Pipeline** (`src/pipeline.ts`): ten steps, each a checkpoint in the ledger. Optional layers (market, duty, policy, signals, contacts) report `unavailable` or `cannot_verify` with a reason instead of failing the run.
- **Ledger** (`src/ledger/ledger.ts`, sqlite): runs with time and credit ceilings; steps with outputs; every external call with endpoint, credits, latency and a per-run memo keyed by request hash; every piece of evidence; actions with idempotency keys; snapshots for the monitor.
- **Kill and restart**: `resume <run-id>` reloads finished steps and re-runs the first unfinished one. Identical calls inside a run are served from the memo, so nothing is paid twice. Actions move proposed → approved → executing → executed; the approved → executing transition is a guarded single UPDATE, so two processes racing after a restart cannot both execute. The time ceiling counts active time per attempt.
- **Semantics** (`src/semantics/`): HS resolver over the UN HS 2022 list, country resolver over the UN partner list with aliases, a curated product-family vocabulary that maps plain English to HS prefixes, distributor language and Crustdata industry values.
- **Context graph and ranking** (`src/graph/`, `src/scoring/`): each run builds a small in-memory graph (request, HS, family, keywords, companies, people, signals, evidence). Fit is rules on the company's own record; graph score is keyword coverage, family membership and support from similar peers; intent is open buying roles and growth; trust is an ordered rule list. Rank is 45 % fit, 25 % graph, 15 % intent, 15 % trust, RED always last.
- **Sources** (`src/sources/`, `src/layers/`): Crustdata REST (company search, enrich, person search, job search, web search), UN Comtrade public preview, World Bank WITS, OFAC and UN sanctions lists loaded locally.
- **API** (`src/api/server.ts`, plain `node:http`): runs, SSE events, resume, retry, ledger, evidence, action approvals. **UI** (`public/`): vanilla HTML and JS, no build step.
- **State lives in** `data/tradescout.db` (sqlite) and `data/out/` (approved drafts). Runs anywhere Node runs.

## Its sources and checks

| Source | Used for | Cost | Where a person approves |
|---|---|---|---|
| Crustdata `POST /company/search` | candidates in market and size band | 0.03 per result + 0.2 for headcount fields | — |
| Crustdata `POST /company/enrich` | top five: headcount history, funding, news | 2 per company | — |
| Crustdata `POST /job/search` | buying and sourcing roles open | 0.03 per posting | — |
| Crustdata `POST /person/search` | the buyer's name, title, employer | 0.03 per profile + 0.1 | — |
| Crustdata `POST /web/search/live` | dated policy news | 1 to 2 per query | undated mentions go to a person |
| UN Comtrade public preview | import value by year, world and India | free | — |
| World Bank WITS tradestats-tariff | applied and MFN sector tariff | free | — |
| OFAC SDN csv, UN consolidated xml (local copies, 22 Nov 2026) | sanctions name screen | free | near-matches shown, cleared by rule |
| UN HS 2022 reference, UN partner areas | HS code and country resolution | free | HS ambiguity is asked back |

Every call is a row in the ledger with endpoint, credits (from the `x-credits-used` header), latency and retrieval time; the UI shows the running total against the ceiling. Every claim in the output carries a source URL, the record id and field it came from, the record's date where the source has one, and the retrieval time. Model calls: none in this build; the ledger has a column for them.

**Personal data.** People appear as name, title and employer from an indexed professional dataset; no emails, phones or profile enrichment are fetched and no outreach is sent. The ledger (`data/tradescout.db` and its `-wal`/`-shm` files) and the drafts in `data/out/` stay on the machine running the desk and are git-ignored.

**Disclosure.** Two mistakes during the build put personal data into this public repository's history and we are not rewriting history, because the rules forbid it. Commit `544a021` included one generated draft `.eml` naming a real executive, removed from tracking in `17c5731`. The sqlite write-ahead and shared-memory files were tracked from the first commit until the commit that adds this paragraph, and they hold the names and titles returned by person search. Both are now ignored. The data is business-role information from a professional dataset, but it should not have been published, and the README said otherwise until now.

## The approaches we tried

- **One wide search with premium fields, then rank** (chosen) over **many narrow searches by industry**: one call keeps the 5-requests-per-minute event key comfortable and the memo makes re-runs free; narrow searches gave better precision in a test but tripled calls and failed the rate limit on resume.
- **Rules for fit, trust and the draft** (chosen) over **an LLM judge**: the same case worded two ways must get the same answer, and judges can argue with a rule. The cost is blunter prose in the drafts.
- **Fetching every candidate's profile URL** was dropped: the person-search record has no profile URL field, and fetching one through enrichment adds personal data the job does not need.
- **Line-level tariffs from WITS TRN** failed: the endpoint rejects EU and national reporters for this dataset. The sector-level tradestats-tariff dataset works and is labelled as such in the report.
- **Comtrade multi-year in one call** failed: the public preview allows one period per call and one call every two seconds, so the market layer makes three paced calls.
- **Counting from the run's creation for the time ceiling** was wrong: a resume after an idle gap tripped the limit. The clock now restarts on each attempt.

## Declared beforehand

A design pack (pitch, flow, trust rules, a diagram sketch and a 7-hour plan) was written before 10:15 AM and is declared on the submission form. No code, prompts or data from before the start are in this repository; the commit history begins at 11:28 IST on 22 November 2026.

## Open-source credits

| Library | Licence |
|---|---|
| typescript, tsx | Apache-2.0, MIT |
| zod | MIT |
| vitest | MIT |
| IBM Plex Sans and Serif (fonts, via Google Fonts) | OFL-1.1 |

Data: UN Comtrade (UN terms of use), World Bank WITS (CC BY 4.0), OFAC SDN and UN Security Council consolidated list (public domain), Crustdata (API terms, event credits).
