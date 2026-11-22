# Submission form answers

**Team name:** (use the same name every time)

**One line:** Meridian drives revenue for export businesses via distribution intelligence: product, HSN and market in; buyers with evidence, the person who decides, and an email checked against that evidence, waiting for approval.

**Theme:** Services, Replaced: the export sales desk and buyer-research service.

**GitHub repo:** https://github.com/shivanshpilani/tradescout/tree/pivot/agentic-buyer-desk (pull request to the team's original repo: https://github.com/Jeevannnn20/tradescout/pull/2)

**Demo video:** (one Loom / unlisted YouTube / Drive link)

**How does your product work?**
Agents think inside a step. Code owns the order, money, state and every action.

1. A planner agent turns product and HSN into an exact product spec, HS codes (each checked against the HS 2022 list) and typed customs queries.
2. Where customs records exist, code runs the queries on export files and computes importers, records, volume and price. A model sees only redacted product descriptions, to pick the exact product.
3. Where they don't, or too few records show the exact product, a researcher agent picks its own Crustdata tools (company search, web search, page read, company lookup) and iterates. Code checks each quote, then a critic agent tries to refute it and can send the researcher back once. This route never claims an import.
4. The client's own buyers and its don't-contact list are removed, and related-party importers are ranked last.
5. A person selects up to five companies. Only then does paid enrichment run: an identity critic rejects same-named strangers, and Crustdata finds the decision-maker and work email.
6. A copywriter agent writes from that buyer's accepted claims. Code and a draft critic check every sentence, and two failures block the draft.
7. A person approves.

Every call is in a ledger with hard per-run and daily caps. A killed run resumes from checkpoints.

**Models and tools:** Gemini 3.6 Flash (researcher, copywriter), Gemini 3.5 Flash-Lite (planner, matcher, critics), Crustdata, Node, TypeScript, SQLite.

**Ran live today:** both routes end to end to checked drafts, and a kill and resume with no paid call repeated. One menthol run cost 12.5 Crustdata credits and $0.026 of model spend.

**Exporter's origin:** read from the exporter's own brief, with a quote that code checks. If the brief doesn't say, India is assumed for ranking only and no email states an origin. A Vietnamese exporter's brief ran live to three checked drafts, all stating Viet Nam.

**Built after the first freeze, inside the extension to 6:30 PM:** that origin change, a retry on model timeouts, and desk actions in the API (edit with critic re-check, batch approve, undo, pause-all). The desk actions are not wired into the interface.

**Not live:** HubSpot sync is tested on a simulator. Gmail outreach and alerts are built and tested offline, limited to team test inboxes, and no email was sent to any buyer. Vendor customs APIs are an interface only. Buyer intelligence is Feature 2.

**Where it needs a person:** selecting companies, importer names that can't be confirmed as the same company, blocked drafts, every approval, and any action with an unknown outcome.

**Approaches considered:** rules only (our morning build: it ranked steel distributors as grating buyers), one prompt (no proof), free-running agents (no bound on cost or actions), and the chosen hybrid of agents inside a durable, capped workflow.

**Diagram and full write-up:** https://github.com/shivanshpilani/tradescout/blob/pivot/agentic-buyer-desk/README.md

**Anything written before 10:15 AM?**
A design pack (pitch, flow, trust rules, a diagram sketch and a plan). Meridian's service business, case study, sales playbooks, customs export files and internal tools also predate the event. The export files are used as input data and are not in the repository. The internal tools are a separate codebase and are not in the repository. The commit history starts at 11:28 IST.

**Per member:** name as registered, BITS email used for credits, YC registration email if different, BITS ID, personal email, GitHub username.
