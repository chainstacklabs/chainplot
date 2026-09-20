# Example 3 — fork a published dataset

A second agent takes a published release and builds a different dashboard —
no RPC, no Postgres, no original credentials (acceptance A10).

## Prerequisites

Example 1 (`examples/transfer-traffic`) built and published. Publishing works
to a directory target or an S3-compatible target (see its `chainplot.yaml`).

> **Note on URL forks:** `fork --from https://…` requires the bucket to allow
> public (unauthenticated) reads. The example R2 bucket is private, so this
> walkthrough forks from the local publish output. The fetch rules are
> identical (checksums, caps, no redirects).

## Fork

`chainplot` below is the CLI from a checkout of this repo: `pnpm build`, then
`alias chainplot="node $PWD/dist/cli/main.js"` (or `pnpm link --global`).

```bash
chainplot fork --from ./dist/releases/local --output ../forked-dashboard --json
# or, against a publish root with latest.json:
chainplot fork --from ./published --output ../forked-dashboard --json
# or, against a public https release root:
chainplot fork --from https://your-bucket.example.com/prefix --output ../forked-dashboard --json
```

The fork copies the pinned snapshot (`datasets/<id>/tables/*.parquet`), the
recipe (`chainplot.yaml`, queries, tests), and **strips the chain/event
sources** — a fork has no chain access. Expanding history or changing
contracts is a new ingest project, not implied by the fork.

## Second agent adds a query

```bash
cd ../forked-dashboard
mkdir -p queries
echo "select count(*) as transfer_count from usdc" > queries/second_agent_count.sql
# add the query + a dashboard panel to chainplot.yaml, then:
chainplot build --json
```

`validate` and `build` run fully offline over the pinned snapshot.
