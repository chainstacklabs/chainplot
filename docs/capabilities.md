# Capability matrix (v0.1)

Machine-readable source of truth: `chainplot capabilities --json`.

## Commands

| Command | Status | Notes |
|---|---|---|
| `capabilities` | shipped | |
| `schema show <kind>` | shipped | 9 kinds, frozen schemas |
| `templates list` | shipped | `fixture-transfers`, `ingest-transfers` |
| `init --template --output` | shipped | |
| `validate` | shipped | offline; cycles, policy combos, refs |
| `doctor` | shipped | S3 write/promote always `unverified` |
| `plan --intent ingest` | shipped | finalized-head probe; budget caps |
| `plan --intent refresh` | shipped | pinned sources skip ingest |
| `plan --intent build` | shipped | no RPC |
| `plan --intent publish` | shipped | publication-only |
| `apply --plan` | shipped | digest-bound, idempotency journal, locks |
| `build` | shipped | full static release; `--mode results_only\|dataset_referenced` |
| `refresh` | shipped | `--publish-target` publishes |
| `query` / `dataset describe` / `test` | shipped | offline over snapshots |
| `serve` | shipped | binds 127.0.0.1 by default; `--host 0.0.0.0` inside a container |
| `publish` | shipped | directory + S3-compatible (R2 verified) |
| `runs list\|show\|cancel` | shipped | cooperative cancel |
| `fork` | shipped | deny-by-default SSRF guard |
| `deploy render`, `watch` | not in v0.1 | spec §1.1 |

## Sources / targets / charts

- Event sources: explicit address lists, one chain per project, rindexer adapter (pinned image, linux/amd64)
- End policies: `pinned` (finality-checked at plan time), `follow_finalized` (requires `finalized` chain policy)
- Publish targets: `directory` (atomic `latest.json`), `s3` (conditional write; verified on Cloudflare R2). Set `prefix` on a target when one bucket or directory holds more than one project — `latest.json` is otherwise a single key at the root and the projects overwrite each other's pointer.
- Publish root: beside `latest.json`, `publish` writes an `index.html` that forwards to the release the pointer names. A release directory is content-addressed, so its URL moves whenever the release does — a change to the viewer bundle is enough, since the bundle is part of the digest. The root is the URL that stays put, and `publish` returns it as `entry_url`. The page is written both at `<prefix>/index.html` and at `<prefix>/`: a host that resolves directories finds the former, an object store that serves keys needs the latter, and writing both keeps the bare URL working on either without a rewrite rule at the CDN. A prefix-less target has no directory key and a `directory` target cannot name a file that way, so those report the explicit `index.html` URL. An `index.html` already at that key without chainplot's marker is left alone and `entry_point_written` comes back false, so publishing into a bucket that serves a site of its own does not replace that site's front page. On `s3` that refusal is enforced by a conditional write and holds against a concurrent writer; on `directory` it is a check followed by a rename, so a foreign file written into the same key mid-publish is overwritten. The page reads `latest.json` in the browser rather than naming a release, so its bytes depend only on the prefix: every publish writes the same page, and the entry point cannot fall behind the pointer whatever order concurrent publishers finish in. It needs script, as does the viewer it forwards to. Both the page and `latest.json` are written `no-cache, must-revalidate`, since a cache that serves either without asking would show an older release.
- Charts: `line`, `bar`, `area`, `kpi`, `table` (allowlisted encodings only)
- Dataset modes: `results_only` (default), `dataset_referenced`, `dataset_included`. The default publishes the page and its results only. `dataset_referenced` uploads the parquet beside the release and records a release-relative path and checksum, so `fork` fetches and verifies it on demand. `dataset_included` copies it into the release. Set per build (`--mode`) or per project (`policy.release_mode`).
- Panel presentation: `title`, `description`, `span` (`half`/`full`), `hide_columns`, `unit`
- Column display: `raw_amount_columns[].decimals` / `.symbol` / `.label` (display only; stored values are never rewritten)

## SQL admission control

Every model and query is parsed by DuckDB (`json_serialize_sql`) before it
runs. A statement that is not a single SELECT is refused — that call rejects
INSERT, COPY, ATTACH, PRAGMA and friends outright, so the rule is the parser's,
not a keyword denylist. Filesystem and network access are disabled before any
project SQL executes, models included: a forked recipe is a stranger's code.

The session runs in UTC. rindexer exports `block_timestamp` as `TIMESTAMP WITH
TIME ZONE`, and DuckDB renders, casts and buckets that type in the session
`TimeZone`, which otherwise follows the machine. The worker pins it, so
`strftime`, `date_trunc`, `hour()` and casts to `TIMESTAMP` give the same
answer on the producer, in a fork in another zone, and in `query` on a laptop.
This is a worker-wide contract, not a per-query option; it needs DuckDB's ICU
extension, which the bundled binaries link statically, and the worker refuses
to run project SQL on a build without it.

`cp_sortkey(v)` is available in every query. It maps a decimal-string amount to
a fixed-width key whose lexicographic order is signed-numeric order, so
`ORDER BY cp_sortkey(value)` sorts uint256 correctly without projecting a
78-digit column into the dashboard. Ordering directly by a declared raw amount
column is refused, including through a select-list alias or a positional
ordinal.

## Enforced limits (spec §14.1)

Each row names where it is enforced, so a claim that stops being true is
visible in review rather than only in production.

| Limit | Default | Enforced in |
|---|---|---|
| Chains per project | 1 | `schemas/project.schema.json` (`maxItems`) |
| Contract addresses | 20 | `schemas/project.schema.json` (`maxItems`) |
| Blocks per approved run | 100_000, `policy.block_budget` to change. A block count, not a duration: 100k blocks is about 14 days on Ethereum (12 s blocks), 2.3 days on Base (2 s), 7 hours on Arbitrum One (0.25 s) — set it for the chain you index | `src/plan/generate.ts` (`DEFAULT_BLOCK_BUDGET`) |
| Query deadline | 60 s | `src/query/runQuery.ts` (`DEADLINE_MS`, SIGKILL) |
| DuckDB memory | 1 GiB, spills to a temp dir | `src/query/workerMain.ts` (`MEMORY_LIMIT`) |
| Returned rows | 10_000, `policy.row_limit` to change | `src/project/limits.ts`, enforced in `src/query/workerMain.ts` (the reader stops at the limit) |
| RPC job wall clock | 30 min, resumable | `src/ingest/rindexer/runBounded.ts` |
| Copied public dataset | 100 MiB | `src/publish/writeRelease.ts` (`MAX_COPIED_BYTES`) |
| Concurrent ingest/publish per project | 1 | `src/runtime/locks.ts` (Postgres advisory lock) |
| `fork` release.json body | 1 MiB | `src/fork/fetchGuard.ts` (`FORK_LIMITS`) |
| `fork` total download | 512 MiB | `src/fork/fetchGuard.ts` (`FORK_LIMITS`) |
| `fork` per-request timeout | 30 s | `src/fork/fetchGuard.ts` (`FORK_LIMITS`) |
| `fork` redirect hops | 0 | `src/fork/fetchGuard.ts` (refused outright) |

`CHAINPLOT_QUERY_MEMORY_LIMIT` overrides the memory figure; the query still
spills to disk rather than failing when it goes over.

The row limit bounds the *download*, not the rendering. The table is
virtualised — 5,000 rows put 26 in the DOM — so a wide result no longer
publishes a page that cannot be scrolled. What remains is that results are
embedded in the release, so every row is bytes a reader fetches before seeing
anything. `policy.row_limit` raises it when a genuinely wide table is worth
that cost.

Two limits listed here through v0.1 described behaviour that did not exist and
have been removed rather than left as promises: a 5 MiB query-result cache
(there is no cache) and a 20-row CLI sample cap (the CLI returns what the query
returns, bounded only by the row limit). A per-run cap on distinct header
fetches is likewise gone: `apply` fetches exactly three headers per job — the
job boundaries — so there was nothing for a budget to bound.

## Environment variables

See `.env.example`. Project-level `.env` (loaded from the directory the CLI
runs in) or the process environment; values never appear in project files.

An ingest project needs exactly one secret of its own: `RPC_URL`. Postgres and
the pinned rindexer binary are supplied by the template's `compose.yaml`, and
`DATABASE_URL` there already points at that service.
