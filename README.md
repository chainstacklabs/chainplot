# Chainplot

**Scoped onchain events → a proven dataset → a static dashboard you can host anywhere.**

Point it at a contract and a block range. It indexes exactly that range, proves
the range is complete, and writes a self-contained directory: the parquet, the
query results, the recipe that produced them, and a viewer. Copy the directory
to any static host and it works — no server, no database, no API key at read
time.

Every command speaks JSON and returns a typed error, so an agent can drive the
whole pipeline without screen-scraping or guessing.

```bash
pnpm install && pnpm build
node dist/cli/main.js init --template fixture-transfers --output ./demo --json
cd demo && node ../dist/cli/main.js build --json && node ../dist/cli/main.js serve --json
```

Nothing puts a `chainplot` command on your PATH — the package is not published.
Where the docs write `chainplot …`, either alias it after `pnpm build`:

```bash
alias chainplot="node $PWD/dist/cli/main.js"
```

or run `pnpm link --global` once from the checkout. Inside the producer
container the command is already on PATH.

---

## Why this instead of a notebook

- **The range is proven, not assumed.** Each indexed segment records its start
  and end block hashes and hash-joins to the previous one. A gap, or a reorg
  that breaks the join, refuses promotion — an incomplete dataset never becomes
  a release.
- **uint256 survives.** Amounts are carried as decimal strings from parquet to
  the page. Nothing passes through a double, so `2^256-1` arrives intact and
  sorts correctly. `ORDER BY` on a raw amount is refused, because `"9"` sorts
  after `"10"` as text; `cp_sortkey()` is built in for the correct ordering.
- **The output outlives the infrastructure.** A published release is static
  files. Your RPC provider, your Postgres, and this CLI can all be gone and the
  dashboard still renders.
- **Anyone can fork it.** A release always ships the recipe, and can ship the
  dataset with it, so a second person imports it, writes a new query, and
  rebuilds — no reindexing, no credentials, no access to your RPC. That costs
  upload size, so it is opt-in: see [What a release weighs](#what-a-release-weighs).

## The pipeline

```text
chainplot.yaml ──▶ plan ──▶ apply ──▶ build ──▶ publish
   contract,        what      index      query,     static files
   block range,     it will   + prove    render,    + latest.json
   queries,         do, and   coverage   bundle     pointer
   dashboards       bounded              viewer
                                                       │
                                            fork ◀─────┘
                                      someone else's release
                                      becomes your project
```

`plan` is read-only and writes a digest-bound plan. `apply` executes that plan
and nothing else — if the config drifts, the digest stops it. Re-applying the
same plan with the same idempotency key is a no-op, so a killed run resumes
instead of duplicating.

## A project in one file

```yaml
format_version: 1
id: transfer-traffic

chain_sources:
  - id: mainnet
    chain_id: 1
    rpc_secret: RPC_URL          # the env var name, never the value
    finality: { policy: finalized }

event_sources:
  - id: usdc
    chain: mainnet
    addresses: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]
    abi: abis/ERC20.json
    events: [Transfer]
    start_block: 18600000
    end: { mode: pinned, block: 18600010 }

datasets:
  - id: usdc
    snapshot: .chainplot/snapshots/usdc/usdc_transfer.parquet

queries:
  - id: top_transfers
    file: queries/top_transfers.sql
    dataset: usdc
    title: Largest transfers
    raw_amount_columns:
      - name: value
        decimals: 6              # display only; the stored integer is untouched
        symbol: USDC
        label: Amount

dashboards:
  - id: transfer-activity
    title: USDC transfer activity
    panels:
      - query: top_transfers
        chart: table
        title: Largest transfers
        span: full               # half (default) or full
```

```sql
-- queries/top_transfers.sql
select value, tx_hash, block_number
from usdc
order by cp_sortkey(value) desc   -- signed-numeric order over decimal strings
limit 10
```

## Commands

| Command | Purpose |
| --- | --- |
| `capabilities` | Machine-readable CLI surface |
| `schema show <kind>` | Print a frozen JSON Schema |
| `templates list` / `init` | Scaffold a project |
| `validate` | Check `chainplot.yaml` offline |
| `dataset describe` / `query` / `test` | Inspect and query a snapshot offline |
| `plan --intent ingest\|refresh\|build` | Write a digest-bound plan (read-only probes) |
| `apply --plan <ref>` | Execute that plan, and only that plan |
| `refresh` | `plan --intent refresh` + `apply` |
| `build` | Write the full static release |
| `serve` | Preview a release; binds 127.0.0.1 unless `--host` says otherwise |
| `publish` | Push a release to a directory or S3-compatible target |
| `runs list\|show\|cancel` | Run journal; cancel is cooperative |
| `fork` | Import a published release as a new project |
| `doctor` | Check credentials, RPC, Postgres, rindexer, storage |

Every command **requires** `--json` and returns
`{ schema_version, ok, command, data, warnings, error }`. Errors carry a code
from a closed set — `validation`, `policy_refused`, `missing_credentials`,
`unsupported_capability`, `source_inconsistent`, `transient_dependency`,
`internal` — plus `retryable` and `suggested_next`.

## Presentation

Panels are declarative. `title`, `description`, `span`, `hide_columns` and
`unit` shape the page; `decimals`, `symbol` and `label` on a raw amount column
shape the numbers. Charts are `line`, `bar`, `area`, `kpi`, `table` — an
allowlist, not an embedded plotting language.

Display metadata never alters stored values. `decimals: 6` renders
`983644533552` as `983,644.533552 USDC`; the exact integer stays in the result
JSON and in the hover title.

## What a release weighs

A release is a static page plus the answers, and that part is about 800 KB
regardless of how much history it covers — most of it the charting bundle,
which is only fetched when a dashboard has a chart. Query *results* are small:
a year of daily figures is a few hundred rows. Tables are virtualised, so a
wide result stays scrollable; what bounds it is the bytes a reader downloads,
and `policy.row_limit` raises that when it is worth paying.

The dataset is separate, and `--mode` decides whether it ships with the page:

| Mode | The page carries | Published beside it | Fork can rebuild |
|---|---|---|---|
| `results_only` (default) | page, results, recipe | — | no — point it at your own snapshot |
| `dataset_referenced` | page, results, recipe, a checksum | the parquet | yes, fetched on demand |
| `dataset_included` | page, results, recipe, **and the parquet** | — | yes |

`dataset_referenced` is usually the one you want if forkability matters: the
page stays under a megabyte, the parquet is uploaded alongside it, and `fork`
pulls it in and verifies it against the checksum only when someone actually
wants to recompute. `dataset_included` puts everything in one directory, which
is simpler to copy around but makes every reader download the data.

Publishing is outward and irreversible, so the default uploads the least that
still works: the page and its answers, without the dataset. Shipping the
parquet is a deliberate choice — it is what lets someone fork the release and
recompute, and it is also what turns an 800 KB page into hundreds of megabytes.
Opt in with `--mode dataset_included`, or `policy.release_mode` in the project
(which is what `apply` and `refresh` use, since neither takes a flag).

The 100 MiB cap applies only to the copied dataset, so it never limits the
dashboard, and the default never trips it. A project whose parquet is larger than that publishes an identical
page with `--mode results_only`; what you give up is the ability for someone
forking it to recompute your numbers from source data, which is why the
default keeps the data in.

## Security

**Forking runs a stranger's SQL on your machine.** That is the whole point of a
portable recipe, and it is contained rather than prevented: queries run in a
separate process with filesystem and network access switched off *before* any
project SQL — models included — and DuckDB's own parser refuses anything that
is not a single SELECT.

What is not defended: a release's checksums come from the same bucket as its
files, so they prove integrity, not authorship. There are no signatures. Fork
only from buckets you would trust with the data.

Full model, including the SSRF guard on `fork --from https://…`:
[`docs/security.md`](docs/security.md).

## Examples

[`examples/`](examples/) — USDC transfer activity (full ingest pipeline), WETH
deposit/withdrawal flows (multi-event source), and forking a published dataset
as a second agent. Both ingest examples are published live:

- [USDC transfer activity](https://pub-0593f9128f674400bcbbc940cf9f01b1.r2.dev/transfer-traffic/latest.json) — 92 transfers, blocks 18,600,000–18,600,010
- [WETH wrap/unwrap](https://pub-0593f9128f674400bcbbc940cf9f01b1.r2.dev/protocol-flows/latest.json) — 258 deposit/withdrawal events over the same range

Publishing more than one project into a single bucket needs a `prefix` on the
target; without one, each project's `latest.json` overwrites the others'.

## Look and feel

The viewer transcribes the Chainstack design tokens from `cp-ui-kit`
(`src/styles/tailwind.css`, `src/styles/theme.ts`) — palette, radius scale and
type sizes — rather than importing the kit, since a release is a static page
with no build step of its own. Fonts are named but not bundled: Suisse Intl is
licensed and releases are published to public buckets, so the page asks for it
and falls back to the system stack.

## Status

v0.1. M0–M5 complete: ingest with coverage proof, snapshots, models, static
dashboards, publish (directory + S3-compatible), fork, doctor. A1–A16 acceptance
with test evidence — including where a criterion was previously asserted too
generously — is in [`docs/acceptance.md`](docs/acceptance.md).

Requires Node 22+ and pnpm. Ingest additionally needs Docker, an archive RPC
endpoint, and Postgres 16; everything else runs offline.

## Development

```bash
pnpm build          # CLI (tsc) + viewer (vite); `build:cli` for the CLI alone
pnpm test           # build, then the full offline suite
```

`viewer/dist` is built, not committed — `pnpm build` produces it and `build`
refuses to write a release without it.

`pnpm test` runs the live suites too, with nothing skipped, given `RPC_URL` and
S3 credentials in `.env` (see [`.env.example`](.env.example)) and a running
Docker. Postgres and the pinned rindexer binary come from compose, so there is
nothing else to install. Without those credentials or Docker, the live suites
skip and the rest still runs.

- Design spec: [`docs/specs/2026-09-12-chainplot-design.md`](docs/specs/2026-09-12-chainplot-design.md)
- Capability matrix and limits: [`docs/capabilities.md`](docs/capabilities.md)
- Compatibility notes (rindexer, DuckDB, R2): [`docs/compatibility.md`](docs/compatibility.md)

## License

MIT for the software. Dataset licenses are separate and must be declared on
every publish target — `publish` refuses without `dataset_license`.
