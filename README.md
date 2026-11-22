# TradeScout

An export sourcing desk, built at ContextCon 05 (BITS Pilani, 22 Nov 2026).

Product and target market in. Out: a cited market signal, a shortlist of real counterparties with a deterministic trust tier, the right procurement contact, and a drafted first email that waits for a person's approval. Every claim links to the record behind it with its date, or says "cannot verify".

## The service
_Which job this takes on, who does it today, and who pays._ (to be written)

## What it does now
(to be written)

## What it could do in the future
(to be written)

## The future of this service
(to be written)

## How to run it
```bash
npm install
cp .env.example .env   # add keys
npm run run -- --product "industrial textiles" --country DEU
npm run resume -- <run-id>   # continues a killed run; each action happens once
npm test
```

## How it's built
See `docs/architecture.md` (diagram) and the layer files under `src/layers`.

## Its sources and checks
(to be written: each data source, where a person approves, the cost ledger)

## The approaches you tried
(to be written)

## Open-source credits
(to be written: library, licence)
