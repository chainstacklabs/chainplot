# Security model

What Chainplot defends, what it does not, and where the boundary sits.

## The one thing to understand

**A `fork` imports someone else's SQL, and the next `build` runs it.**

`fork` copies `source/chainplot.yaml`, `source/queries/` and `source/models/`
out of a published release into a new project. Those files are the recipe;
running `build` executes them against DuckDB on your machine. Forking an
untrusted release is therefore closer to running a downloaded script than to
downloading a CSV, and the containment below is what makes it safe rather
than the file format.

## Containment

Query execution happens in a forked child process (`src/query/workerMain.ts`),
never in the CLI process:

| Control | Where |
|---|---|
| Separate process, env stripped to `PATH`/`HOME`/`LANG` | `src/query/runQuery.ts` |
| In-memory DuckDB; no database file on disk | `workerMain.ts` |
| Extension autoinstall and autoload disabled | `workerMain.ts` |
| `enable_external_access=false` **before any project SQL runs** | `workerMain.ts` |
| Single-SELECT admission control, via DuckDB's parser | `src/query/sqlGuard.ts` |
| 60 s deadline, SIGKILL on expiry | `runQuery.ts` |
| Row limit enforced by stopping the reader, not by truncating after | `workerMain.ts` |

Ordering matters and is the part that was wrong before 2026-09-15. Snapshots
are read first, because `read_parquet` needs filesystem access. External
access is then disabled, and only after that are models materialized and the
query run. Models are project-supplied SQL like any other, so they must land
on the closed side of that door; DuckDB does not allow external access to be
re-enabled within a session.

### Admission control

Every model and query is parsed before it executes:

```sql
SELECT json_serialize_sql('<the statement>')
```

That call fails on anything that is not a SELECT — `Only SELECT statements can
be serialized to json!` — which covers INSERT, UPDATE, COPY, ATTACH, PRAGMA,
SET, INSTALL and LOAD without maintaining a keyword denylist. It also reports
the statement count, so `SELECT 1; DROP TABLE t` is refused as two statements
rather than passing a check aimed at the first. The statement is parsed, not
run, by this call.

## What is *not* defended

- **Authenticity of a published release.** `release.json` lists a SHA-256 for
  every file, and `fork` verifies each one. That detects corruption in
  transit; it does not establish provenance, because the checksums and the
  files come from the same bucket. There are no signatures. Whoever can write
  to the bucket can serve a consistent, hostile release. **Fork only from
  buckets you would trust with the data itself.**
- **Denial of service by a hostile recipe.** Bounded, not eliminated: a forked
  query gets 60 s, a row limit, and a 1 GiB memory cap that spills to a temp
  directory rather than failing. A release can still make your build slow, and
  can still fill that temp directory.
- **Secrets you place inside the recipe directories.** The source bundle is an
  allowlist — `chainplot.yaml`, `abis/`, `models/`, `queries/`, `tests/`,
  `schemas/` — and nothing else is copied into a release. Everything inside
  those directories *is* published. `.env` is never among them.
- **The snapshot's own contents.** Chainplot publishes what you indexed.
  Deciding whether onchain data is publishable is yours.

## Fetching (`fork --from https://…`)

`src/fork/fetchGuard.ts` is deny-by-default:

- HTTPS only.
- DNS is resolved once and the connection is pinned to that address, so a
  rebind between check and connect cannot redirect it.
- Loopback, link-local, ULA, and RFC1918 ranges are refused, in IPv4, IPv6,
  and IPv4-mapped IPv6 form. Decimal, hex, and octal IP literals are
  normalized before the check.
- Redirects are refused outright rather than followed.
- 1 MiB cap on `release.json`, 512 MiB on the release, 30 s per request. A
  `dataset_referenced` release adds one fetch per dataset, counted against the
  same 512 MiB total and verified against the checksum the manifest records.
- `--allow-private-networks` is the documented, explicit escape hatch for
  testing against a local server.

## Reporting

Report a vulnerability privately through GitHub: the repository's Security
tab → Report a vulnerability. Please do not open a public issue for anything
exploitable. Everything else is welcome in the issue tracker.
