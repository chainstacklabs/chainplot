# Acceptance — A1–A16 (v0.1)

Spec: `docs/specs/2026-09-12-chainplot-design.md` §18. Every ID maps to test
evidence on `main`. "Live" = run against real infrastructure (archive RPC,
Cloudflare R2); everything else runs offline.

`pnpm test` runs everything, live suites included, with nothing skipped. The
live tests need only `RPC_URL` and the S3 credentials in `.env` plus a running
Docker — Postgres and the pinned rindexer binary come from the template's own
`compose.yaml`, which the ingest test brings up itself.

**A12 was wrong until 2026-09-15.** It was marked Pass on the strength of
tests that never ran a hostile *model*, and a model materialized before
filesystem access was disabled. A forked release could read any file the
build process could and publish it. Fixed in `src/query/workerMain.ts`;
`tests/fork/hostileRelease.test.ts` now exercises the whole
publish → fork → build path and fails if the ordering regresses. See
[`docs/security.md`](security.md) for the trust boundary this rests on.

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| A1 | Agent creates a dashboard from ABI + bounded history; no browser automation, no undocumented steps | `examples/transfer-traffic` (92 real USDC transfers, plan → apply → build → serve); fixture quickstart (`tests/cli/a15.e2e.test.ts`) | Pass (live + offline) |
| A2 | Chart title change → presentation rebuild only, no backfill | `tests/cli/a2.e2e.test.ts` | Pass |
| A3 | Earlier history / another contract = explicit additional work; no silent expansion | `tests/cli/ingestCommands.test.ts` (ingest-relevant edit → `refresh` refuses `policy_refused`); `tests/ingest/planApply.test.ts` (config drift → refuse) | Pass |
| A4 | Kill producer during indexing/export/upload → safe resume; previous release intact | `tests/ingest/runBounded.test.ts` (early exit, wall clock); journal resume (`tests/ingest/planApply.test.ts` failed-run re-apply); S3 live: previous release intact after re-publish. Live kill-mid-indexing exercised via wall-clock path | Pass |
| A5 | Same plan + idempotency key twice → no duplicate data, no mixed release | `tests/ingest/planApply.test.ts` (reused outcome, no second run); live M2 e2e (92 rows unchanged) + live S3 re-publish | Pass (live + offline) |
| A6 | Zero-event interval → `complete_empty` with positive evidence, or refuse | `tests/ingest/inspectCoverage.test.ts` (cursor ≥ end + 0 rows); M0 probe; flush-race settle re-check (`src/plan/apply.ts`) | Pass |
| A7 | Canonical boundary change → detect inconsistency, do not promote | `tests/ingest/planApply.test.ts` (hash-join break → `source_inconsistent`, coverage unchanged) | Pass |
| A8 | uint256 set round-trips exactly; sort-key order is numeric | `tests/cli/build.test.ts` (raw decimal strings through storage/JSON); fixture includes `±2^53±1`, `±2^255`, `2^256-1`; `tests/query/models.test.ts` orders the fixture with `cp_sortkey` and compares against a BigInt sort; `tests/viewer/format.test.ts` covers display scaling and BigInt compare | Pass |
| A9 | Producer + DB + RPC down → public dashboard still renders | `tests/cli/a2.e2e.test.ts` (served release over plain HTTP); demo deployments during M3–M5 with all services absent | Pass |
| A10 | Second agent imports published data, writes a new query — no reindexing, no original credentials (the producer opts in, with `dataset_referenced` or `dataset_included`; the default publishes the page alone and `fork` warns when there is no data). `tests/fork/importRelease.test.ts` covers the referenced round trip and rejects a tampered dataset; verified live against R2 by forking a published release over HTTPS and recomputing offline | `tests/cli/a10.e2e.test.ts`; example 3 (fork of the ingest release, new query + dashboard, offline build) | Pass |
| A11 | Copy project to a clean machine, run Compose → config changes environmental only | `examples/transfer-traffic` + `examples/protocol-flows` run end-to-end in fresh containers (amd64 producer image, our Postgres); no analytics files rewritten | Pass (live) |
| A12 | Malicious filenames, labels, SQL, secret-like content → no execution, no path escape, no credential exposure | `tests/fork/hostileRelease.test.ts` (publish → fork → build with a hostile model: filesystem read refused, non-SELECT refused, no result written); `tests/query/models.test.ts` (same at the query layer, plus multi-statement); `tests/query/sqlGuard.test.ts` (admission policy); `tests/fork/fetchGuard.test.ts` (SSRF blocklist, traversal); `tests/fork/importRelease.test.ts` (checksum, undeclared files); identifier validation (`tests/ingest/inspectCoverage.test.ts`); doctor never echoes secrets | Pass (regression-tested since 2026-09-15; previously asserted without a hostile-model case) |
| A13 | Exceed query/scope/output/publication limits → typed refusal, no silent truncation | `tests/publish/modes.test.ts` (100 MiB cap → choices); `tests/ingest/planApply.test.ts` (block budget caps `job_end`); `tests/query/models.test.ts` (row limit → `policy_refused`; the reader stops at the limit rather than materializing the full result first) | Pass |
| A14 | Missing secrets or wrong chain identity → precise diagnosis, no hang, no destructive fallback | `tests/cli/ingestCommands.test.ts` (`missing_credentials`); finalized-null → no fallback (`tests/rpc/client.test.ts`) | Pass |
| A15 | Fixture-only quickstart with network disabled | `tests/cli/a15.e2e.test.ts` | Pass |
| A16 | `refresh` on pinned-complete project rebuilds, no ingest; address/destination edit → `policy_refused` | `tests/cli/ingestCommands.test.ts` (both halves, zero-RPC asserted) | Pass |

## Live evidence runs

- **M2 ingest e2e** (2026-09-13): plan → apply → coverage → idempotent re-apply → no-op plan → gate, in the amd64 producer container against archive RPC + our Postgres 16. 92 USDC rows, matching M0.
- **M4 S3** (2026-09-13): conditional-write probe + publish/re-publish cycle against Cloudflare R2 (`tests/publish/live/s3.live.test.ts`).
- **M5 examples** (2026-09-14): both ingest examples executed via Compose in fresh containers; example 3 forked and built offline.
- **Re-run on the current code** (2026-09-16): both ingest examples re-ingested from mainnet through the containerised rindexer (92 USDC transfers, 258 WETH events over blocks 18,600,000-18,600,010, coverage complete with chain timestamps), built, and published to R2 under per-project prefixes. The ingest and S3 live suites both run in `pnpm test` and pass.

## Known gaps

- **Authenticity of a forked release is not established.** `release.json`
  carries checksums for its own files, so a fork detects corruption in
  transit, but the checksums and the payload come from the same place.
  Whoever controls the bucket controls both. There are no signatures;
  `fork` is safe against a hostile *recipe* (A12), not against a
  substituted *publisher*. Only fork buckets you would trust with the data.
- **Nothing here is signed.** See the authenticity gap above; it is the one
  substantive control the design does not yet have.
