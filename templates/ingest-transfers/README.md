# Ingest template

Scoped onchain events → a proven dataset → a static dashboard.

Postgres and the pinned rindexer binary both come from `compose.yaml`. The only
thing you supply is an archive-capable RPC endpoint.

## One-time: build the producer image

The producer image is the Chainplot CLI plus rindexer. It is built from a
Chainplot checkout, not from this project — a scaffolded project has no CLI
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
docker compose exec producer chainplot serve --host 0.0.0.0 --port 4173 --json
```

The last command keeps running; open <http://127.0.0.1:4173> in a browser on
this machine. `compose.yaml` publishes that port to the host's loopback only,
and `--host 0.0.0.0` is what lets the container answer on it — the default bind
is the container's own loopback, which nothing outside can reach.

`plan` is read-only and writes a digest-bound plan; `apply` executes that plan
and nothing else. A release is refused unless the whole pinned block range is
proven complete.

Everything the container writes into this directory — `.chainplot/`, `dist/` —
is owned by you, not by root: the CLI in the container runs as the owner of
the project directory.

## Files

| File | Purpose |
|---|---|
| `chainplot.yaml` | Project definition: source scope, queries, dashboard |
| `compose.yaml` | Postgres + producer runtime |
| `abis/ERC20.json` | ABI for the `Transfer` event |
| `queries/transfer_count.sql` | KPI: number of transfers |
| `.env.example` | Copy to `.env`; `RPC_URL` is the only value you provide |
