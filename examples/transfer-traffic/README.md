# Example 1 — USDC transfer activity

Scoped onchain events → dataset → static dashboard, end to end.

**Chain:** Ethereum mainnet · **Source:** USDC (`0xa0b86991…`) `Transfer` events
**Range:** blocks 18,600,000–18,600,010 (pinned, finalized) · **Expected:** 92 transfers

## Run it

Requires: Docker, and an archive-capable Ethereum RPC in `.env` (see `.env.example`).

```bash
# 1. Start Postgres + producer (CLI + pinned rindexer, no docker.sock).
#    This example builds the producer image from the repo; a scaffolded
#    project uses `image: ${CHAINPLOT_IMAGE:-chainplot:local}` instead.
docker compose up -d --build

# 2. In the producer container: plan → apply → build
docker compose exec producer chainplot plan --intent ingest --json
docker compose exec producer chainplot apply --plan <plan_id> --json
docker compose exec producer chainplot build --json

# 3. Preview the dashboard: serve inside the container, open it from the host
docker compose exec producer chainplot serve --host 0.0.0.0 --port 4173 --json
# then open http://127.0.0.1:4173 in a browser on this machine
```

Coverage evidence comes from `rindexer_internal.*.last_synced_block` plus
boundary header hashes; the release is refused unless the whole pinned range
is proven complete.

## Files

| File | Purpose |
|---|---|
| `chainplot.yaml` | Project definition (source scope, queries, dashboard, publish target) |
| `abis/ERC20.json` | ABI for the `Transfer` event |
| `queries/transfer_count.sql` | KPI: number of transfers |
| `queries/top_transfers.sql` | Table: largest transfers, ordered with `cp_sortkey` |
| `tests/` | Assertions over the snapshot |
