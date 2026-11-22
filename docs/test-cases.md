# Test cases

Gathered before the live run. Every case uses records dated after 1 September 2026 (Crustdata records carry their retrieval date; Comtrade and WITS rows carry their period). Hard cases are marked. "Correct result" is what the service must return; a guess fails the case.

| # | Request | Correct result | Kind |
|---|---|---|---|
| 1 | product "industrial textiles", country "Germany", 20 to 2000 staff | A shortlist of German companies whose Crustdata record shows the country and a headcount in range; the top five enriched and tiered; every row with at least one source; HS resolved to a textile heading with the three candidate headings listed as a question. | happy path |
| 2 | product "basmati rice", country "Narnia" | Run stops at parse with "cannot verify the target country"; no search call, zero credits. | cannot verify |
| 3 | two search records with the same domain (seen live: ids 101 and 106 in the fixture, real duplicates in Crustdata) | One row, both ids listed under "duplicate record merged". Two rows fail. | duplicate |
| 4 | two companies whose names share a distinctive first word, different domains ("Nordfaser Technische Textilien GmbH" and "Nordfaser Handels GmbH") | Both rows kept, both flagged "lookalike of …; verify before contacting". Merging fails. | lookalike |
| 5 | a candidate the enrich call returns no record for | Trust AMBER with "insufficient data: no enrichment record"; the row is listed under needs-a-person with "cannot verify". GREEN fails. | cannot verify |
| 6 | a candidate with a 12-month headcount change below −30 % or two adverse news items | Trust RED; sorted last; no draft proposed for it. | rule |
| 7 | a company name matching an OFAC SDN entry at ≥ 92 ("Aerocaribbean Airlines S.A.") | RED with the list name and score; "Nordfaser Technische Textilien GmbH" clears. | sanctions |
| 8 | kill the process during the contacts step, then resume | Steps before contacts are reused, contacts re-runs, no search or enrich is paid again, drafts are proposed once, the run finishes. | robustness |
| 9 | enrich endpoint returns 500 | Run finishes; every tier is AMBER or worse; the enrich failure is listed under needs-a-person. | source failure |
| 10 | credit ceiling 0.5 | Run stops with status budget_exceeded before the second paid call. | ceiling |
| 11 | same request run twice | Second run's monitor shows the previous snapshot and a change list (empty when nothing moved). | monitor |
| 12 | policy news with no publication date | Does not set the policy flag; listed as "undated mention needs a person". A year in the text older than last year or in the future is not a date. | cannot verify |

Cases 2 to 12 run offline in `tests/` against a stubbed Crustdata (mock data in tests only). Case 1 was run live on 22 November 2026 at 12:27 IST: 25 companies, 5 GREEN, 3 buyers, 3 drafts, 29.2 credits after the market, duty and policy layers.
