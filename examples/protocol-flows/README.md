# Example 2 — WETH deposit/withdrawal flows

Two events from one contract (`WETH9`, `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`):
`Deposit(address,uint256)` and `Withdrawal(address,uint256)` — the wrap/unwrap
activity of wrapped Ether.

**Range:** blocks 18,600,000–18,600,010 (pinned, finalized).

## Run it

Same runtime as example 1 (see its README): `docker compose up -d`, then
`plan --intent ingest` → `apply` → `test` → `build` → `serve` inside the
producer container. Requires `.env` with an archive-capable `RPC_URL`.

## What it shows

- Multiple declared events on one contract (two tables: `weth_deposit`,
  `weth_withdrawal`).
- Two datasets, one dashboard with a KPI per flow and a comparison table.
