# TradeScout architecture

```mermaid
flowchart LR
  U[Request: product + country] --> P[parse: HS code, ISO3, keyword map]
  P -->|cannot verify| Q[question back to the person]
  P --> M[market: Comtrade imports, 3 years, one call per year]
  P --> T[tariff: WITS sector tariff, India vs MFN]
  P --> PW[policy: Crustdata web search, dated news only]
  P --> S[search: Crustdata company/search, widened once]
  S --> G[(context graph, in memory: request, HS, keywords, companies, signals)]
  S --> F[fit: ICP rules]
  F --> E[vet: Crustdata company/enrich top N + sanctions CSV]
  E --> TR[trust tier rules]
  TR --> I[intent: Crustdata job/search aggregations]
  I --> C[contacts: Crustdata person/search]
  C --> D[draft: first email, proposed action]
  D --> A{approve / reject}
  A -->|approved| X[(executed once: file)]
  M & T & PW & TR & I & C --> R[report with evidence]
  R --> MON[monitor: diff vs previous snapshot]
  subgraph ledger [sqlite run ledger]
    L1[runs, steps = checkpoints]
    L2[calls = cost ledger, per-run memo]
    L3[evidence]
    L4[actions, idempotency keys]
  end
```

- Every box with an external call goes through `ctx.call`, which checks the time and credit ceiling, memoises identical calls inside a run, and writes a ledger row with credits and latency.
- Every step commits its output as a checkpoint; `resume <run-id>` continues from the first unfinished step.
- Actions move proposed → approved → executing → executed; the approved → executing transition is a guarded UPDATE, so a restart cannot execute an action twice.
- Layers marked optional (market, tariff, policy, intent, contacts, monitor) report `unavailable` or `cannot_verify` with a reason instead of failing the run.
- Retries: 429 waits for `x-ratelimit-reset`; 5xx backs off; 4xx is final. Comtrade is paced at one call per 2.2 s. A source that times out leaves its layer unavailable; it never reads as an answer.
- Where state lives: `data/tradescout.db` (runs, steps, calls, evidence, actions, snapshots) and `data/out/` (approved drafts). The in-process event bus feeds SSE; the ledger is the truth after a restart.
- Personal data: name, title and employer only, from person search; no contact enrichment; drafts never leave the machine.
