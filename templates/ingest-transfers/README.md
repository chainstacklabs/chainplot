# Ingest template

Scoped onchain events → a proven dataset → a static dashboard.

Postgres and the pinned rindexer binary both come from `compose.yaml`. The only
thing you supply is an archive-capable RPC endpoint.

## One-time: build the producer image

The producer image is the chainplot CLI plus rindexer. It is built from a
chainplot checkout, not from this project — a scaffolded project has no CLI
sources. rindexer ships linux/amd64 only, so build for that platform:

```bash
docker build --platform linux/amd64 -t chainplot:local \
  -f docker/producer.Dockerfile .
```

Set `CHAINPLOT_IMAGE` to use a different tag.

## Run it

```bash
cp .env.example .env        # then fill in RPC_URL
docker compose up -d

docker compose exec producer chainplot plan --intent ingest --json
docker compose exec producer chainplot apply --plan <plan_path> --json
docker compose exec producer chainplot build --json
docker compose exec producer chainplot serve --port 4173 --json
```

`plan` is read-only and writes a digest-bound plan; `apply` executes that plan
and nothing else. A release is refused unless the whole pinned block range is
proven complete.

## Files

| File | Purpose |
|---|---|
| `chainplot.yaml` | Project definition: source scope, queries, dashboard |
| `compose.yaml` | Postgres + producer runtime |
| `abis/ERC20.json` | ABI for the `Transfer` event |
| `queries/transfer_count.sql` | KPI: number of transfers |
| `.env.example` | Copy to `.env`; `RPC_URL` is the only value you provide |
