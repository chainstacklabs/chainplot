# Chainplot M4 Publish and Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship publish (directory + one S3-compatible adapter), `latest.json` conditional promotion, dataset modes with size caps, `doctor`, and `fork` with deny-by-default SSRF rules. Gate: a failed upload leaves the previous complete release usable; another agent forks using only published data.

**Architecture:** `src/publish/` gains a `PublishTarget` interface with two implementations (`directory`, `s3`). Publication protocol per spec §16.2: staging release already exists from `build` → validate → upload immutable files → verify → promote `latest.json` **last** (single small pointer: release prefix + checksum of that release's `release.json`). Directory promotion is atomic rename; S3 promotion is a conditional PUT (`If-Match` on current pointer, `If-None-Match: *` for first publish). `fork` imports a release from a local dir or https URL into a new project with pinned snapshots; fetch rules are deny-by-default (§16.4).

**Tech Stack:** Adds `@aws-sdk/client-s3` (v3) — pinned via `pnpm add`. Everything else unchanged.

**Spec:** `docs/specs/2026-09-12-chainplot-design.md` §9.1 (`doctor`, `publish`, `fork`), §14.1 (caps), §16 (release/publish/fork), §16.3 (S3 adapter), §16.4 (fork fetch rules).

## Global Constraints

- All M1–M3 constraints hold.
- **No endpoint URLs or credentials in the repo.** S3 endpoint/keys/bucket come from env (`CHAINPLOT_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CHAINPLOT_S3_BUCKET`, optional `CHAINPLOT_S3_REGION`); tests read env and `it.skip` when absent. `.env` stays gitignored.
- Publication order is fixed: immutable files → verify → promote `latest.json` last. Interrupted upload leaves the previous complete release.
- `latest.json` is never stored inside `releases/<id>/`. Promotion is a single object write. Never copy a release into a `latest/` directory.
- S3 write/promote permission is proven only at upload time; `doctor` marks S3 `unverified` (HeadBucket at most).
- If an S3-compatible target cannot do conditional writes + read-after-write, refuse the target (`unsupported_capability`), never last-write-wins.
- Dataset size cap: copied public dataset 100 MiB compressed. Exceeding it → typed refusal with choices (reference mode, reduce data, results-only). Never silent truncation.
- `fork` fetch rules (§16.4, deny by default): local dir or https only; redirects forbidden (0 hops); resolve DNS and validate every address against the blocklist (loopback, link-local, ULA, RFC1918, CGNAT, unspecified, IPv4-mapped forms; reject decimal/octal/hex IP literals decoding to blocked addresses); pin the resolved address for the connection; block path traversal and undeclared files; validate `latest.json` → `release.json` → manifests against frozen schemas and §14.1 caps **before** downloading bodies; stream bodies with hard byte caps (`release.json` ≤ 1 MiB, total ≤ 512 MiB, per-request timeout 30 s); verify checksums as bytes arrive; escape hatch for private nets is an explicit documented flag, default off.
- `fork` never executes imported recipes, installs extensions, or runs hooks. Unreviewed imported SQL is never auto-run.
- Software license (MIT) is not dataset license: publishing requires an explicit `dataset_license` field; `source/` descriptions are in the allowlist review.
- v0.1 retention is manual; no `prune`.
- Do not add `.markdownlint.yaml`.

## Later plans (out of this file)

M5: three examples, A1–A16 full pass, multi-arch Compose smoke, capability matrix, upstream notices + dataset license statements.

---

## File structure

| Path | Responsibility |
|---|---|
| `schemas/publish-target.schema.json`? | No — publish targets live in `project.schema.json` (`publish_target` def gains fields) |
| `src/publish/target.ts` | `PublishTarget` interface + target resolution from project doc |
| `src/publish/directory.ts` | Directory target: copy immutable files, atomic `latest.json` |
| `src/publish/s3.ts` | S3-compatible target: upload, verify, conditional promote |
| `src/publish/latestPointer.ts` | `latest.json` shape + checksum computation |
| `src/publish/publishRelease.ts` | Protocol orchestration (validate → upload → verify → promote) |
| `src/publish/doctor.ts` | `doctor` command logic |
| `src/fork/fetchGuard.ts` | DNS/IP blocklist, pinning, no-redirect fetch with byte caps |
| `src/fork/importRelease.ts` | Validate pointers/manifests, stream + verify, write new project |
| `src/cli/commands/publish.ts` | `publish` command |
| `src/cli/commands/fork.ts` | `fork` command |
| `src/cli/commands/doctor.ts` | `doctor` command |
| `tests/publish/*.test.ts` | Directory target, pointer, protocol, modes/caps |
| `tests/publish/live/*.test.ts` | Env-gated S3 (R2) tests |
| `tests/fork/*.test.ts` | fetchGuard (mock DNS/HTTP), importRelease |
| `tests/cli/doctor.test.ts` | doctor offline paths |

---

## Shared types (lock these names)

```ts
// src/publish/target.ts
export interface PublishTargetDoc {
  id: string;
  type: "directory" | "s3";
  path?: string;   // directory target
  bucket?: string; // s3 target (bucket name; endpoint/keys via env)
  dataset_license?: string; // required at publish time
  public_base_url?: string;
}

export interface LatestPointer {
  schema_version: 1;
  release_prefix: string;      // e.g. "releases/local-1731..."
  release_json_checksum: string; // sha256 hex of that release's release.json bytes
}

export interface PublishResult {
  target_id: string;
  release_prefix: string;
  latest_url: string | null;   // public_base_url + latest.json when configured
  files_uploaded: number;
  promoted: boolean;
}

export interface PublishTarget {
  uploadFiles(releaseDir: string, prefix: string, files: string[]): Promise<void>;
  verifyFiles(prefix: string, files: string[], checksums: Record<string, string>): Promise<void>;
  readLatest(): Promise<LatestPointer | null>;
  promoteLatest(pointer: LatestPointer): Promise<void>; // conditional write
}
```

```ts
// src/fork/fetchGuard.ts
export interface FetchGuardOptions {
  allowPrivateNetworks?: boolean; // default false
  maxBytes: number;
  timeoutMs: number;              // per request, default 30_000
}
export function assertAllowedUrl(url: string, opts: FetchGuardOptions): Promise<void>;
export function guardedFetch(url: string, opts: FetchGuardOptions): Promise<Response>; // no redirects, byte-capped stream
```

---

### Task 1: `latest.json` pointer + directory target

**Files:** Create `src/publish/latestPointer.ts`, `src/publish/directory.ts`, `src/publish/target.ts`; extend `project.schema.json` `publish_target` def (`dataset_license`, `public_base_url`); `tests/publish/directory.test.ts`.

Cases: pointer checksum = sha256 of release.json bytes; directory publish copies files under `releases/<id>/`, writes `latest.json` at root via temp+rename (assert no partial state on simulated crash: temp name left behind is ignored); second publish of a new release flips the pointer atomically; previous release directory untouched; `latest.json` never inside `releases/<id>/`.

- [ ] Failing test → implement → pass → commit `feat: latest pointer and directory publish target`

### Task 2: `plan --intent publish`, `publish` command, refresh wiring

**Files:** Modify `src/plan/generate.ts` (publish intent: actions `[{type:"publish"}]`, requires an existing built release + target in project; no RPC), `src/plan/apply.ts` (execute publish action via target), `src/cli/commands/publish.ts` (sugar: plan + apply), `src/cli/commands/refresh.ts` (`--publish-target` now publishes), `src/cli/run.ts`, capabilities; `tests/publish/publishCommand.test.ts`.

Cases: publish without prior build → `validation` ("run build first"); publish with `dataset_license` missing → `policy_refused` naming the field; `--publish-target` not in project → `policy_refused`; publish plan makes no RPC; refresh with valid target publishes after rebuild (A16 complete path); publish plan is digest-bound (config drift refused).

- [ ] Failing test → implement → pass → commit `feat: publish command and publish plans`

### Task 3: Dataset modes + size caps

**Files:** Modify `src/publish/writeRelease.ts` (mode selection: `dataset_included` default; `results_only` when total parquet size > 100 MiB unless project opts into reference mode; `dataset_referenced` writes a pointer manifest instead of tables), `tests/publish/modes.test.ts`.

Cases: small fixture → `dataset_included` with tables; oversized (inject a >100 MiB parquet via sparse file) → build refuses with typed refusal listing choices; `results_only` mode omits `datasets/<id>/tables/` and manifest says so; `dataset_referenced` manifest carries external snapshot pointer + checksum, no tables.

- [ ] Failing test → implement → pass → commit `feat: dataset modes and size caps`

### Task 4: `doctor`

**Files:** Create `src/publish/doctor.ts`, `src/cli/commands/doctor.ts`, register; `tests/cli/doctor.test.ts`.

Checks (each reported as `{name, status: ok|fail|unverified|skipped, detail}`): project file parses; secrets present (RPC_URL env ref, DATABASE_URL) without values echoed; chain id + `eth_chainId` + finalized head probe (skipped offline); rindexer binary on PATH or `CHAINPLOT_RINDEXER_BIN` (version probe, skipped when absent); writable storage (touch `.chainplot/doctor.tmp`); S3: HeadBucket only, write/promote marked `unverified`. `doctor` must not start indexing. Offline run: RPC + rindexer + S3 skipped, exit ok.

- [ ] Failing test → implement → pass → commit `feat: doctor command`

### Task 5: S3 conditional-write probe (R2) — env-gated

**Files:** Create `tests/publish/live/s3probe.live.test.ts`; record evidence in `docs/compatibility.md`.

Needs env: `CHAINPLOT_S3_ENDPOINT` (the R2 URL), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CHAINPLOT_S3_BUCKET=chainplot-test`, optional `CHAINPLOT_S3_REGION=auto`. Skips when absent.

Probe: PutObject `probe/initial` → GetObject read-after-write → conditional PutObject with `If-None-Match: *` (must succeed on new key, must fail 412 on existing key) → conditional PutObject with `If-Match` of the current ETag (must succeed; stale ETag must fail 412) → DeleteObject cleanup. Record which conditions R2 honors; if any required condition is unsupported, record `unsupported_capability` verdict for S3 targets in `docs/compatibility.md` (directory publish remains the v0.1 path).

- [ ] Write probe → run with creds from the human → record evidence → commit `test: S3 conditional-write probe against R2`

### Task 6: S3 publisher

**Files:** `pnpm add @aws-sdk/client-s3`; create `src/publish/s3.ts`; `tests/publish/live/s3publish.live.test.ts` (env-gated, uses the probe bucket).

Behavior: `uploadFiles` PutObjects under `<prefix>/`; `verifyFiles` HeadObject + checksum compare (sha256 of body for small files, ETag+size for large); `readLatest` GetObject `latest.json` (404 → null); `promoteLatest` conditional PUT (`If-None-Match: *` when no pointer exists, `If-Match: <current etag>` otherwise; 412 → `policy_refused` "concurrent promotion detected"). Offline unit tests with a mocked S3Client interface; live test does a real publish + re-publish cycle against R2 and asserts the pointer flipped and 412 on stale ETag.

- [ ] Unit tests (mocked client) → implement → live test with creds → commit `feat: S3-compatible publish target`

### Task 7: `fork` — fetch guard + import

**Files:** Create `src/fork/fetchGuard.ts`, `src/fork/importRelease.ts`, `src/cli/commands/fork.ts`, register; `tests/fork/fetchGuard.test.ts`, `tests/fork/importRelease.test.ts`.

fetchGuard cases: http URL refused; redirect refused (mock server 302 → error); loopback/`127.0.0.0/8`/`::1`/RFC1918/CGNAT/link-local/ULA/unspecified refused; decimal IP literal (`2130706433`) resolving to 127.0.0.1 refused; hex/octal literals refused; IPv4-mapped IPv6 refused; `allowPrivateNetworks: true` escape hatch permits them; byte cap aborts mid-stream; timeout aborts.

importRelease cases: local directory import of a built fixture release → new project with pinned snapshot (`datasets/<id>/tables/*.parquet` copied), copied `chainplot.yaml` (ids preserved), no `.env`, no recipe execution (assert no hooks run — none exist); `release.json` > 1 MiB refused before body; undeclared file in release dir refused; path-traversal filename in manifest refused; checksum mismatch refused; forked project passes `validate` offline and `build` works over the pinned snapshot (A10 core).

- [ ] Failing tests → implement → pass → commit `feat: fork with deny-by-default fetch guard`

### Task 8: Acceptance + docs

**Files:** `tests/cli/a10.e2e.test.ts` (second agent: fork a published directory release, write a new query over the pinned snapshot, build a new dashboard — no RPC/Postgres/credentials); `README.md`, `docs/compatibility.md`.

- [ ] A10 test → docs → commit `test: A10 fork acceptance and M4 docs`

---

## Verification checklist (M4 gate)

- [ ] `pnpm test` green offline (S3/fork live tests skip).
- [ ] Failed S3 upload leaves previous release + pointer intact (live test).
- [ ] 412 on stale ETag promotion → `policy_refused` (live test).
- [ ] `fork` of the R2-published release works with only the public URL (needs public access or a second signed read — record which; if the bucket is private, fork test uses the local-directory path and URL fork is documented as needing public read).
- [ ] No endpoint URLs or keys in tracked files (no tracked file mentions the S3 endpoint hostname or keys).
- [ ] `capabilities` lists `publish`, `fork`, `doctor`.
