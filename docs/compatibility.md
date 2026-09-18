# Compatibility

## M5 complete (2026-09-14)

Examples, acceptance, multi-arch smoke done. v0.1 scope (M0–M5) implemented.

| Piece | Evidence |
| --- | --- |
| Multi-arch Dockerfile smoke | `linux/amd64`: full build + live ingest runs (M2/M5). `linux/arm64`: image builds, `capabilities --json` runs; **rindexer binary cannot execute on arm64** (upstream publishes amd64-only) — ingest requires amd64, documented limitation |
| rindexer version in image | 0.43.0 (pinned image digest) |
| Examples | `examples/transfer-traffic` (92 USDC transfers), `examples/protocol-flows` (150 WETH deposits + 108 withdrawals), `examples/fork` — all executed end-to-end |
| Acceptance | `docs/acceptance.md` — A1–A16 all pass (live where noted) |

### M5 corrections recorded

1. Multi-event sources: coverage inspection aggregates **all** declared
   events (worst status, summed rows); export writes one Parquet per
   (source, event). Single-event sources unchanged.
2. rindexer forks children that keep writing after the parent exits —
   `stopAndQuiesce` now signals the whole process group (`detached` spawn +
   `kill(-pid)`), then coverage is inspected.
3. `complete_empty` immediately after SIGTERM can be a flush race (cursor
   commits before final row flush): apply re-inspects after a 3 s settle
   window; genuinely empty ranges stay `complete_empty` (A6).
4. `forbidOrderByRaw` strips SQL line comments first — comment mentions of a
   raw column no longer trip the guard.
5. Forks strip `chain_sources`/`event_sources`: a fork has no chain access
   (spec §16.4); the forked project is dataset-only.

## M4 implemented (2026-09-13)

Publish/fork on `main`: directory target with atomic `latest.json` (temp+rename), `plan --intent publish` + `publish` command + `refresh --publish-target`, dataset modes with the 100 MiB cap (`build --mode results_only|dataset_referenced`), `doctor`, `fork` with deny-by-default fetch guard (https only, 0 redirects, IP blocklist incl. decimal/hex/octal literals and IPv4-mapped forms, DNS pinning, byte caps, pointer-checksum verification), per-file checksums in `release.json`.

| Piece | Pin |
| --- | --- |
| S3 SDK | `@aws-sdk/client-s3` v3 (pnpm lock) |
| S3 env | `CHAINPLOT_S3_ENDPOINT`, `CHAINPLOT_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CHAINPLOT_S3_REGION` (default `auto`) |
| S3 promotion | `If-None-Match: *` on first write, `If-Match` on current ETag after; 412 → `policy_refused` |
| Live S3 evidence | **Proven 2026-09-13 against Cloudflare R2** (`tests/publish/live/s3.live.test.ts`, env-gated): read-after-write ✓; `If-None-Match: *` on existing key → 412 `PreconditionFailed` ✓; `If-Match` current ETag → success ✓; stale ETag → 412 ✓; full publish → re-publish cycle flipped the pointer, previous release still readable, pointer checksum matched release.json bytes. R2 honors both conditional-write headers — the last unproven M0 assumption is closed. S3-compatible targets are supported, not refused. |
| Unit coverage | mocked `S3Ops`: first-promote `If-None-Match`, 412 → `policy_refused`, checksum verify |

Notes:
- `doctor` marks S3 write/promote `unverified` — proven only at upload time.
- `fork` verifies `release.json` against the `latest.json` pointer checksum, then every declared file against its per-file checksum; undeclared files are never fetched.
- Fork of a results-only release requires `source/chainplot.yaml` (recipe); refused otherwise.

## M3 accepted (2026-09-13)

Full static build on `main`: SELECT model graph (topo order, cycles refused at
`validate`, SELECT-only enforced in the isolated worker), extended `build`
(full §16.1 layout minus `latest.json`: `index.html`, `assets/`,
`dashboards/`, `results/`, `datasets/<id>/{manifest.json,tables/*.parquet}`,
`source/` allowlist), viewer bundle (React + Vite + ECharts, committed under
`viewer/dist/`, no CDN), `serve` (127.0.0.1 by default, `--host` to change), `plan --intent build`
(no RPC). A2 + A9 groundwork pass offline.

| Piece | Pin |
| --- | --- |
| viewer deps | react 19, echarts 6, vite 7 (`viewer/package.json`, own lockfile) |
| viewer bundle | committed `viewer/dist/`; rebuild with `pnpm --dir viewer build` |
| release id | `local-<ts>` staged then renamed to `dist/releases/local` (M4 adds real ids + `latest.json`) |

Notes:
- Raw-amount columns are published in `results/<query>.json`
  (`raw_amount_columns`) so the viewer sorts them with BigInt numeric compare,
  never `localeCompare` (§12/§15).
- `source/` copies only `chainplot.yaml`, `abis/`, `models/`, `queries/`,
  `tests/`, `schemas/` — never `.env`, `.chainplot/`, `dist/`.

## M2 ingest accepted (2026-09-13)

M2 scope implemented on `main`: `plan --intent ingest|refresh` → `apply` with
bounded rindexer jobs, coverage from `rindexer_internal.*.last_synced_block`
plus header hashes, DuckDB postgres-ATTACH export, run journal, locks, cancel,
and the product Compose + Dockerfile. `plan --intent build|publish` returns
`unsupported_capability` (M3/M4). S3 still untouched (M4).

| Piece | Pin |
| --- | --- |
| rindexer binary in producer image | copied from `ghcr.io/joshstevens19/rindexer@sha256:9b33…97dd` at `/app/rindexer` → `/usr/local/bin/rindexer`. Binary is linux/amd64 ELF; runs on amd64 hosts, not on arm64 hosts (no arm64 image exists upstream). |
| Producer image | built from repo root: `docker build -f templates/ingest-transfers/Dockerfile -t chainplot-producer .`; `capabilities --json` verified inside the container. |
| DuckDB postgres extension | pre-installed in the image (`INSTALL postgres`); extension dir `v1.5.5`. |
| New dependency | `pg` (advisory lock + coverage cursor reads; session-scoped advisory locks cannot go through DuckDB's pooled ATTACH). |
| Live e2e | **Run 2026-09-13** in an amd64 producer container against our Postgres 16 + `RPC_URL` from `scripts/m0-probe/.env` (env only, never committed). Full scenario passed: plan (finalized-head probe) → apply (rindexer 11 blocks, 92 USDC rows — matches M0) → coverage segment with 3 header hashes → idempotent re-apply (`reused: true`, still 92 rows) → second plan is a no-op (`job_start > job_end`, no ingest action) → coverage removed → `build` refused `policy_refused` → `refresh` with `RPC_URL` unset rebuilt only (A16). |

### M2 live-run corrections (2026-09-13)

1. rindexer requires top-level `name` in the manifest; it derives table names
   from it, not from the network: event table `{name}_{contract}.{event}`,
   cursor `rindexer_internal.{name}_{contract}_{event}`. `renderConfig` sets
   `name: chainplot_<networkName>`.
2. Producer image installs `libssl3` (rindexer links it; bookworm-slim omits it).
3. A failed `apply` now records `status: failed` in the journal (was `running`,
   which blocked resume).
4. The promotion gate moved into `buildRelease` so every build path (standalone
   `build`, `apply`, `refresh`) refuses incomplete sources.
5. rindexer table naming confirmed live: cursor
   `rindexer_internal.chainplot_chainplot_1_usdc_transfer` (`last_synced_block
   = 18600010`, `network = chainplot_1`), event table
   `chainplot_chainplot_1_usdc.transfer` (92 rows).

### M2 decisions recorded

1. rindexer network name is `chainplot_<chain_id>` (e.g. `chainplot_1`), so
   table names are deterministic: `rindexer_internal.chainplot_1_<contract>_<event>`.
2. `validate` skips the snapshot-file existence check for projects with
   `event_sources` (ingest materializes snapshots at apply); dataset-only
   projects still require the file.
3. `plan` demands credentials only when work needs them: no finalized-head
   probe and no `DATABASE_URL` check when every pinned source is already
   complete (spec §11 no-ingest refresh).
4. `apply` is injectable (`exportFn`/`buildFn`) for offline tests; the real
   exporter runs DuckDB in a forked child (`src/ingest/exportWorkerMain.ts`)
   with `ATTACH … (TYPE POSTGRES, READ_ONLY)`, `CAST(block_number/tx_index AS
   BIGINT)`, literal `chain_id`, and a physical-uniqueness gate before COPY.

## M1 accepted (2026-09-13)

Fixture CLI on `main`: `init` → `validate` → `query` → `test` → `build`.
A15 passes with network disabled. No ingest, S3, or viewer.

| Tool | Version |
| --- | --- |
| Node.js | `>=22 <27` (`package.json` `engines`) |
| pnpm | `11.24.0` |
| `@duckdb/node-api` | `1.5.5-r.4` |

DuckDB neo in-memory `select 1` verified during M1.

## M0 ingest probe (2026-09-13)

Runtime: Docker Compose in `scripts/m0-probe/`. **Our** Postgres 16, pinned rindexer image, **no docker.sock**. Matches spec ingest boundary.

| Piece | Pin |
| --- | --- |
| rindexer image | `ghcr.io/joshstevens19/rindexer@sha256:9b33da8cea740b74ebfdfd3932682e8ceab79cbcf2eb3a7ca0863ac413794dd7` (`:latest` that day). Tag `v0.43.1` does not exist on GHCR. Image is **linux/amd64** only; ran on arm64 via qemu. |
| Postgres | `postgres:16-alpine` |
| RPC | `RPC_URL` env (archive-capable Ethereum JSON-RPC). `eth_getBlockByNumber("finalized")` and archive `eth_getLogs` verified. Publicnode archive `eth_getLogs` is 403. |
| Window | inclusive archive `18600000`–`18600010` via `RPC_URL`. Earlier publicnode run used a near-head window because publicnode archive `eth_getLogs` is 403. |

### Verified

- Inclusive `start_block`/`end_block`. Historic job finishes (`Historical indexing completed`). Process **does not exit** (health server on 8080). M2 must SIGTERM after that log line.
- Archive via `RPC_URL`: USDC `18600000`–`18600010` → 92 rows; empty contract → 0 rows; both cursors `last_synced_block = 18600010`; 0 null `block_hash`/`block_timestamp`.
- Resume (earlier publicnode near-head run): after stop, raising `end_block` restarts at `last_synced_block + 1` (`25967330`). USDC rows 935 then +909 = 1844. No rescan of the first window.
- Empty-range evidence: cursor at `end_block` with **0** rows. Completeness is the cursor, not `max(block)` / row count. A6: `last_synced_block >= end_block` and row count 0 → `complete_empty`.
- Per-log `block_hash` and `block_timestamp` both present, **0 nulls**, with `timestamp: true` on the contract. No header-enrichment stage required for this pin.
- `value` is Postgres `varchar(78)` (decimal string). DuckDB postgres scanner keeps it `VARCHAR`.
- Cursor table: `rindexer_internal.{indexer}_{contract}_{event}` columns `network text PK`, `last_synced_block numeric`.
- Event table (no-code): `contract_address`, `from`, `to`, `value`, `tx_hash`, `block_number numeric`, `block_timestamp timestamptz`, `block_hash`, `network`, `tx_index numeric`, `log_index varchar(78)`.
- Snapshot export path **1 works**: DuckDB `INSTALL postgres; ATTACH … TYPE POSTGRES; COPY … TO parquet`. Must `CAST(block_number AS BIGINT)` and `CAST(tx_index AS BIGINT)` — scanner maps PG `numeric` to DuckDB **DOUBLE**. `value` stays string through parquet.

### Not verified this run

- S3 `If-Match` / `If-None-Match` (M4).
- linux/arm64 rindexer image (none published; qemu only).
- `reorg_block_hashes` stayed empty on these historic windows.

### Spec consequences for M2

1. Coverage evidence = `rindexer_internal.*.last_synced_block`, not max event block.
2. Always set `timestamp: true`.
3. Export through DuckDB postgres extension with explicit casts; do not trust scanner types for `numeric`.
4. Stop rindexer with SIGTERM after historic complete; do not wait for process exit.
5. Ingest tests need `RPC_URL` (archive + `finalized`). Do not use publicnode for historical `eth_getLogs`.
