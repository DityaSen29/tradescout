# Submission form answers (checkpoint 2:30 PM, final before 6:00 PM)

**Team name:** (use the same name every time)

**One line:** An export sourcing desk: product and market in; a cited market signal, duty and policy picture, vetted counterparties with a trust tier, the right buyer at each, and a drafted first email that waits for a person's approval.

**Theme:** Supply chain, with Trust and compliance (own combination).

**GitHub repo:** https://github.com/Jeevannnn20/tradescout

**Demo video:** (one Loom / unlisted YouTube / Drive link, two minutes, a request it has never seen)

**How does your product work?**
Ten checkpointed steps on live data: parse the request (HS code, ISO3, keyword map; asks back when the HS code is a near-tie, stops when the country cannot be verified), market (UN Comtrade, three years), duty (World Bank WITS, sector level, India vs MFN), policy (dated news naming the market; undated items go to a person), find counterparties (one Crustdata company search, fit by rules, duplicates merged, lookalikes flagged), vet (enrich top five, OFAC and UN name screen, adverse news, deterministic trust tier where missing data is AMBER), buying signals (job postings), find the buyer (person search, name/title/employer only), draft (proposed action, nothing sent), report (ranked over an in-memory context graph, every claim with a source link that opens the stored record). Where it still needs a person: HS ambiguity, undated policy mentions, counterparties without a record, name-only sanctions matches, approving and sending every draft. Approaches considered: wide search then rank (chosen) vs many narrow searches; rules (chosen) vs an LLM judge; line-level tariffs (WITS refused) vs sector level. Models and tools: no LLM calls in this build; Node 26, TypeScript, Node's built-in sqlite, plain node:http, vanilla JS UI. Next: shipment-record evidence, weekly watcher, an LLM for messy requests behind the same evidence contract.

**Diagram:** https://github.com/Jeevannnn20/tradescout/blob/main/docs/architecture.md

**Anything written before 10:15 AM?**
A design pack written before the start: a pitch, the five-step flow, the trust-tier and fit rules, a Mermaid diagram sketch and a 7-hour plan. No code, prompts or data. It is not in the repository; the commit history starts at 11:28 IST.

**Per member:** name as registered, BITS email used for credits, YC registration email if different, BITS ID, personal email, GitHub username.
