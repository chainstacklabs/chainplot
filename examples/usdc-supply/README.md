# Example 3 — USDC supply changes over a year

The widest example: a year of Ethereum mainnet, and the only one that uses
indexed filters, a model, and time-series charts.

**Chain:** Ethereum mainnet · **Source:** USDC (`0xa0b86991…`) `Transfer`
**Range:** blocks 23,400,000–25,987,000 (~1 year, pinned, finalized)
**Events:** ~6.8M (4.8M mints, 2.0M burns)

## Why it is shaped this way

- **Indexed filters do the work.** A mint is a `Transfer` from the zero
  address and a burn is one to it, so each source filters on a different
  indexed position. USDC emits ~82 transfers per block; filtering cuts that by
  99%, which is what makes a year tractable at all. Two sources, because
  `eth_getLogs` cannot express "from = 0 OR to = 0" in one call.
- **`block_budget: 400000`.** A year is ~2.6M blocks, far past the 100k
  default. 400k keeps each job inside the 30 minute wall clock, so every run
  closes and records coverage rather than being killed mid-job. Expect ~7 runs
  of `plan` → `apply`; each one resumes where the last finished.
- **`release_mode: results_only`.** The parquet is ~163 MB; the page it feeds
  is under a megabyte. This is the default, stated here because the contrast
  is the point.
- **A model spanning both datasets.** `models/daily.sql` unions mints and
  burns into one row per UTC day. Every dataset is in scope in every query, so
  a model may read across them.

## Run it

Build the producer image once from a chainplot checkout, then:

```bash
cp .env.example .env        # fill in RPC_URL
docker compose up -d

# Repeat until a plan reports no ingest work left; each run advances coverage.
docker compose exec producer chainplot plan --intent ingest --json
docker compose exec producer chainplot apply --plan <plan_path> --json
```

The run that closes the range also exports and builds. Intermediate runs
ingest only — they cannot build, because the promotion gate refuses anything
short of complete coverage.

## Files

| File | Purpose |
|---|---|
| `chainplot.yaml` | Two filtered sources, a model, seven queries, five panel types |
| `models/daily.sql` | One row per day, unioned across mints and burns |
| `queries/` | KPIs, a daily bar series, a cumulative area series, a line series, a top-N table |
