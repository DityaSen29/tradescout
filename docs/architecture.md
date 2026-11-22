# TradeScout architecture

```mermaid
flowchart LR
  U[Request: product + country] --> P[parse: HS code, ISO3, keyword map]
  P --> M[market: Comtrade imports 5y]
  P --> T[tariff: WITS applied duty]
  P --> S[search: Crustdata company/search]
  S --> G[(graph: companies, people, HS, signals, evidence)]
  S --> F[fit: ICP rules]
  F --> E[vet: Crustdata company/enrich top N + sanctions CSV]
  E --> TR[trust tier rules]
  TR --> I[intent: Crustdata job/search aggregations]
  I --> C[contacts: Crustdata person/search]
  P --> PW[policy: Crustdata web/search/live, dated news]
  C --> D[draft: first email]
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
- Layers marked optional (market, tariff, policy, intent, monitor) report `unavailable` with a reason instead of failing the run.
