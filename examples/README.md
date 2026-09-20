# Chainplot examples

| Example | What it shows | Needs network? |
|---|---|---|
| [`transfer-traffic`](./transfer-traffic) | Full ingest pipeline: USDC `Transfer` events → Parquet snapshot → dashboard. 92 real transfers over blocks 18,600,000–18,600,010. | Yes (archive RPC) for ingest; offline afterwards |
| [`protocol-flows`](./protocol-flows) | Multi-event source: WETH `Deposit` + `Withdrawal` (150 + 108 events over the same range), two datasets, KPI dashboard. | Yes (archive RPC) for ingest; offline afterwards |
| [`fork`](./fork/README.md) | Second agent forks a published release and builds a new dashboard with its own query — no RPC, no Postgres, no credentials. | No |

Each example directory is a complete Chainplot project: `chainplot.yaml`,
`abis/`, `queries/`, `tests/`, `compose.yaml` (Postgres + producer with the
pinned rindexer binary), and `.env.example`.

## Quickstart (transfer-traffic)

```bash
cd examples/transfer-traffic
cp .env.example .env            # fill in RPC_URL
docker compose up -d
docker compose exec producer node /app/dist/cli/main.js plan --intent ingest --json
docker compose exec producer node /app/dist/cli/main.js apply --plan <plan_id> --json
docker compose exec producer node /app/dist/cli/main.js build --json
docker compose exec producer node /app/dist/cli/main.js test --json
```

Then `serve` the release and open the printed URL.
