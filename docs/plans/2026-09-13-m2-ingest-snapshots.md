# Chainplot M2 Ingest and Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ingest: `plan --intent ingest|refresh` → `apply` runs a bounded rindexer job against our Postgres, proves coverage from `rindexer_internal.*.last_synced_block` plus header hashes, exports a Parquet snapshot through DuckDB, and refuses to promote incomplete data. Plus run journal, locks, cancel, and the product Compose + Dockerfile.

**Architecture:** One package. `src/ingest/` owns the `IngestAdapter` interface and the rindexer implementation (generated gitignored config, subprocess, coverage inspection). `src/rpc/` is a minimal JSON-RPC client for finalized head and coverage-boundary headers. `src/plan/` generates digest-bound plans and executes them. Coverage segments live in `.chainplot/coverage.json`; run state in `.chainplot/runs/<idempotency-key>/`. The DuckDB **query worker** stays isolated (no PG/RPC env, unchanged from M1); the **exporter** is a separate DuckDB child that may `ATTACH` Postgres.

**Tech Stack:** Unchanged from M1 (`Node >=22 <27`, pnpm 11, TypeScript, vitest, ajv, yaml, commander, `@duckdb/node-api` 1.5.5-r.4). New dependency: `pg` (Postgres client) for the advisory lock and coverage-cursor reads — session-scoped advisory locks cannot go through DuckDB's pooled postgres ATTACH. rindexer runs as a subprocess binary (`CHAINPLOT_RINDEXER_BIN`, default `rindexer` on PATH); the Compose Dockerfile copies the pinned rindexer binary out of the pinned image. No AWS SDK yet (M4).

**Spec:** `docs/specs/2026-09-12-chainplot-design.md` is authority. M0 evidence: `docs/compatibility.md` (cursor table, resume = `last_synced_block + 1`, SIGTERM after `Historical indexing completed`, DuckDB postgres ATTACH with `CAST(block_number/tx_index AS BIGINT)`, `timestamp: true` gives native `block_hash`/`block_timestamp`, empty-range evidence = cursor at `end_block` with 0 rows).

## Global Constraints

- CLI envelope, error codes, `--json`/`--jsonl` rules: unchanged from M1. New commands register in `capabilities` only when implemented.
- **Never** commit or document an RPC URL. Live tests read `RPC_URL` / `CHAINPLOT_TEST_DATABASE_URL` from the environment and `it.skip` when absent. `.env` stays gitignored.
- Jobs only append. No overlap-tail re-ingest. `job_start = last_proven_complete_block + 1`, `job_end = min(job_target_end, job_start + block_budget - 1)`.
- `follow_finalized` requires chain finality `finalized`. `follow_finalized` + `confirmation_depth` → `unsupported_capability` (already refused at `validate`; `plan` re-checks).
- A `pinned` `end_block` must satisfy finality at plan time (`≤ finalized` or `≤ head − depth`), else `policy_refused`.
- Completeness evidence is the rindexer cursor, never `max(block_number)` or row count. Zero rows + cursor ≥ `end_block` → `complete_empty`.
- Coverage segments record `start_block_hash`, `end_block_hash`, `start_block_parent_hash` from `eth_getBlockByNumber` header fetches (3 per segment: `job_start-1`, `job_start`, `job_end`). Adjacent segments hash-join iff number-adjacent **and** parent link matches; otherwise `source_inconsistent`, not complete.
- Generated rindexer config: `project_type: no-code`, Postgres storage enabled, GraphQL disabled, explicit addresses only, `include_events` limited to declared signatures, `timestamp: true`, always explicit `start_block`/`end_block`, RPC via `${RPC_URL}` env interpolation. Config file is gitignored.
- Stop rindexer with SIGTERM after the `Historical indexing completed` log line; do not wait for process exit. Wall clock 30 min → SIGTERM + `transient_dependency`, resumable.
- Export SQL: `CAST(block_number AS BIGINT)`, `CAST(tx_index AS BIGINT)`; `value` and other uint256 stay VARCHAR decimal strings; add `chain_id` as a literal column. Physical uniqueness `(chain_id, block_number, tx_hash, log_index)`; same key with different `block_hash` → `source_inconsistent`.
- Block budget applies to the first ingest too. Default budget 100_000 (`policy.block_budget` overrides). A budget-split pinned range is finished by repeated `plan --intent ingest` + `apply`, never by `refresh`.
- `build` never talks to RPC. Promotion gate: a snapshot whose sources are not complete over `[start_block, required_end]` must not produce a release; `policy_refused` naming the source and missing range. Hash-join break → `source_inconsistent`.
- One active ingest writer per project: local lock file (`.chainplot/locks/ingest.lock`, `O_EXCL`) **plus** Postgres advisory lock (`pg_try_advisory_lock`). Concurrent `apply` → `policy_refused`.
- No docker.sock anywhere. Compose: `producer` (CLI + rindexer binary) + `postgres:16-alpine`.
- Do not restore any RPC URL or provider hostname into the repo, docs, commits, or test fixtures.
- Do not add `.markdownlint.yaml`.

## Later plans (out of this file)

M3: SELECT model graph re-export, viewer, `serve`, full static `build`, `plan --intent build` behavior.
M4: directory + S3 publish, `latest.json` conditional promotion, `fork`, `plan --intent publish`, S3 conditional-write probe.
M5: examples, A1–A16, multi-arch smoke.

In M2, `plan --intent build|publish` returns `unsupported_capability` (typed, not silent).

---

## File structure

| Path | Responsibility |
|---|---|
| `schemas/plan.schema.json` | Frozen plan kind (replaces M1 stub) |
| `schemas/coverage.schema.json` | Frozen coverage kind (replaces M1 stub) |
| `schemas/progress.schema.json` | Frozen progress-event envelope (replaces M1 stub) |
| `src/rpc/client.ts` | JSON-RPC over HTTP, closed error mapping |
| `src/rpc/heads.ts` | `getFinalizedHead`, `getHeader` |
| `src/ingest/adapter.ts` | `IngestAdapter` interface + shared job/report types |
| `src/ingest/coverage.ts` | Segment store, hash-join, `lastProvenCompleteBlock`, completeness |
| `src/ingest/rindexer/renderConfig.ts` | `chainplot.yaml` → rindexer YAML text |
| `src/ingest/rindexer/runBounded.ts` | Spawn, watch for historic-complete, wall clock, signals |
| `src/ingest/rindexer/inspectCoverage.ts` | Cursor + row count via `pg`, classify 4 statuses |
| `src/ingest/exporter.ts` | DuckDB ATTACH → Parquet + uniqueness + manifest fields |
| `src/plan/digest.ts` | Canonical JSON + sha256 helpers |
| `src/plan/generate.ts` | Plan generation for `ingest`/`refresh` intents |
| `src/plan/apply.ts` | Verify, lock, execute actions, record coverage |
| `src/plan/refresh.ts` | Authorization classification for `refresh` |
| `src/runtime/journal.ts` | `.chainplot/runs/<key>/` plan copy, status, checkpoints |
| `src/runtime/locks.ts` | Local lock file + pg advisory lock |
| `src/cli/commands/plan.ts` | `plan --intent` |
| `src/cli/commands/apply.ts` | `apply --plan` |
| `src/cli/commands/refresh.ts` | `refresh [--publish-target]` |
| `src/cli/commands/runs.ts` | `runs list|show|cancel` |
| `templates/ingest-transfers/` | Ingest scaffold: `chainplot.yaml`, ABI, `.env.example`, `compose.yaml`, `Dockerfile` |
| `tests/rpc/*.test.ts` | Mock-server RPC tests |
| `tests/ingest/*.test.ts` | Coverage, renderConfig, runBounded (fake binary), plan/apply |
| `tests/ingest/live/*.test.ts` | Env-gated live tests (RPC + Postgres) |

---

## Shared types (lock these names)

```ts
// src/ingest/adapter.ts
export type CoverageStatus =
  | "not_indexed"
  | "incomplete"
  | "complete_empty"
  | "complete_with_rows";

export interface BoundedJob {
  sourceId: string;
  contractName: string;      // lowercase PG identifier; drives table names
  networkName: string;       // `chainplot_<chain_id>`
  chainId: number;
  addresses: string[];
  abiPath: string;           // absolute, inside project dir
  events: string[];
  jobStart: number;          // inclusive
  jobEnd: number;            // inclusive
  rpcUrl: string;
  databaseUrl: string;
  workDir: string;           // .chainplot/ingest/<source_id>/ (gitignored)
}

export interface RunHandle {
  job: BoundedJob;
  pid: number;
  completedLogSeen: boolean;
}

export interface CoverageReport {
  status: CoverageStatus;
  lastSyncedBlock: number | null; // from rindexer_internal cursor; null = no row
  rowCount: number;
}

export interface IngestAdapter {
  renderConfig(job: BoundedJob): string;
  runBounded(job: BoundedJob, opts: RunOptions): Promise<RunHandle>;
  stopAndQuiesce(handle: RunHandle): Promise<void>;
  inspectCoverage(job: BoundedJob): Promise<CoverageReport>;
}
```

```ts
// src/ingest/coverage.ts
export interface CoverageSegment {
  start_block: number;
  end_block: number;
  start_block_hash: string;
  end_block_hash: string;
  start_block_parent_hash: string;
  status: "complete_empty" | "complete_with_rows";
  row_count?: number;
}

export interface SourceCoverage {
  source_id: string;
  segments: CoverageSegment[];
}

export interface CoverageFile {
  schema_version: 1;
  chain_id: number;
  sources: SourceCoverage[];
}

export function lastProvenCompleteBlock(
  segments: CoverageSegment[],
  projectStartBlock: number,
): number;
export function hashJoinOk(prev: CoverageSegment, next: CoverageSegment): boolean;
export function requiredEnd(
  end: EventEnd,
  segments: CoverageSegment[],
): number | null; // pinned → declared block; follow_finalized → max segment end or null
export function isComplete(
  segments: CoverageSegment[],
  projectStartBlock: number,
  end: EventEnd,
): { complete: boolean; reason: string | null };
```

```ts
// src/plan/digest.ts
export function canonicalJson(value: unknown): string;   // sorted keys, no whitespace
export function sha256Hex(text: string): string;
```

```ts
// src/plan/generate.ts
export interface PlanSource {
  source_id: string;
  end_mode: "pinned" | "follow_finalized";
  job_start: number;
  job_end: number;          // resolved inclusive bound for THIS job
  job_target_end: number;   // declared end_block or resolved_safe_end
  required_end: number | null;
  blocks_remaining: number; // job_target_end - last_proven_complete_block, ≥ 0
}

export interface PlanDocument {
  schema_version: 1;
  plan_id: string;          // sha256 of canonical plan without plan_id
  intent: "ingest" | "refresh";
  project_id: string;
  project_digest: string;   // sha256 of raw chainplot.yaml bytes
  created_at: string;       // UTC ISO
  chain: { chain_id: number; finality: Finality };
  sources: PlanSource[];
  actions: Array<
    | { type: "ingest"; source_id: string }
    | { type: "export"; source_id: string }
    | { type: "build_results" }
  >;
  limits: { block_budget: number; blocks_in_range: number };
  deletes_data: boolean;
  makes_data_public: boolean;
  state_assumptions: {
    sources: Record<string, { last_proven_complete_block: number }>;
  };
  publish_target: string | null;
}
```

Plan file lives at `.chainplot/plans/<plan_id>.json`. `plan` prints the path in `data.plan_path`; `apply --plan` accepts a path or a plan id.

---

### Task 1: Freeze `plan`, `coverage`, `progress` schemas

**Files:**
- Modify: `schemas/plan.schema.json`
- Modify: `schemas/coverage.schema.json`
- Modify: `schemas/progress.schema.json`
- Create: `tests/cli/schemaKinds.test.ts`

**Interfaces:**
- Consumes: `schema show` from M1
- Produces: draft 2020-12 schemas with `additionalProperties: false`; `coverage`/`plan` shapes above.

`progress.schema.json`: required `schema_version` (const 1), `type` (const `"progress"`), `run_id`, `stage` (string); optional `message`, `rows`, `output_bytes`, `retries`, `ts` — all typed, no free-form fields.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/schemaKinds.test.ts
import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("frozen M2 schema kinds", () => {
  for (const kind of ["plan", "coverage", "progress"]) {
    it(`${kind} is closed (additionalProperties false)`, async () => {
      const result = await runCliJson(["schema", "show", kind, "--json"], cwd);
      expect(result.ok).toBe(true);
      const schema = result.data as { additionalProperties: boolean };
      expect(schema.additionalProperties).toBe(false);
    });
  }

  it("coverage requires segment boundary hashes", async () => {
    const result = await runCliJson(["schema", "show", "coverage", "--json"], cwd);
    const schema = result.data as { $defs: Record<string, { required: string[] }> };
    expect(schema.$defs.segment.required).toEqual(
      expect.arrayContaining([
        "start_block_hash",
        "end_block_hash",
        "start_block_parent_hash",
        "status",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/schemaKinds.test.ts`

Expected: FAIL (stubs have `additionalProperties: true`).

- [ ] **Step 3: Write the schemas** per Shared types. `plan.schema.json` freezes the `PlanDocument` shape (without `plan_id` in `required`, since the id is computed over the rest — keep `plan_id` as an optional string property so `apply` can validate a finished plan).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`

Expected: PASS (16 existing + new).

- [ ] **Step 5: Commit**

```bash
git add schemas tests/cli/schemaKinds.test.ts
git commit -m "feat: freeze plan, coverage, progress schemas"
```

---

### Task 2: RPC client — finalized head and headers

**Files:**
- Create: `src/rpc/client.ts`
- Create: `src/rpc/heads.ts`
- Create: `tests/rpc/client.test.ts`

**Interfaces:**

```ts
// src/rpc/client.ts
export class RpcError extends Error {
  constructor(
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}
export interface RpcClient {
  call<T>(method: string, params: unknown[]): Promise<T>;
}
export function createRpcClient(url: string, fetchImpl?: typeof fetch): RpcClient;
```

Network/HTTP failure or JSON-RPC error object → `RpcError(retryable: true)` (maps to `transient_dependency` at call sites). Malformed response → `RpcError(false)` → `internal`.

```ts
// src/rpc/heads.ts
export interface BlockHeader {
  number: number;
  hash: string;       // lowercase hex
  parentHash: string; // lowercase hex
}
export async function getFinalizedHead(client: RpcClient): Promise<BlockHeader>;
// eth_getBlockByNumber ["finalized", false]; null result → RpcError(false) "node cannot supply finalized block" — no fallback
export async function getHeader(client: RpcClient, blockNumber: number): Promise<BlockHeader>;
// eth_getBlockByNumber [hexQuantity, false]; null → RpcError(false) "block vanished" (source_inconsistent at call sites)
```

- [ ] **Step 1: Write the failing test** — spin `node:http` createServer on port 0 returning canned JSON-RPC responses; assert happy path, JSON-RPC error → retryable, connection refused → retryable, `finalized` → `null` → non-retryable, hex quantity parsing (`"0x5f5e0ff"` → 100000000... use small numbers).
- [ ] **Step 2: Run to verify FAIL** (`pnpm exec vitest run tests/rpc/client.test.ts`).
- [ ] **Step 3: Implement** with global `fetch`, 30 s per-request timeout (`AbortSignal.timeout`), no redirects followed (`redirect: "error"`).
- [ ] **Step 4: Run to verify PASS** (`pnpm test`).
- [ ] **Step 5: Commit**

```bash
git add src/rpc tests/rpc/client.test.ts
git commit -m "feat: add JSON-RPC client for finalized head and headers"
```

---

### Task 3: Coverage segments — hash-join and proven-complete derivation

**Files:**
- Create: `src/ingest/coverage.ts`
- Create: `tests/ingest/coverage.test.ts`

Pure functions only; no I/O in this task. Table-driven cases (spec §9.2, §11):

1. No segments → `lastProvenCompleteBlock = start_block - 1`.
2. Single segment `[start, end]` with `start_block = projectStart` → proven = end.
3. Segment starting after `projectStart` (gap at the front) → proven = `start_block - 1`.
4. Two number-adjacent segments with matching parent link → proven = second end.
5. Two number-adjacent segments, parent link mismatch → proven = first end only (the join is `source_inconsistent`; `isComplete` returns `complete: false, reason: "hash_join_broken"`).
6. Gap between segments → proven = first end.
7. Pinned, proven < declared end → `isComplete` false, reason `"truncated"` (a pinned range killed at 60% stays incomplete).
8. Pinned, proven ≥ declared end → complete.
9. `follow_finalized` with zero segments → `requiredEnd` null, `isComplete` false, reason `"not_indexed"`.
10. `follow_finalized` with contiguous segments → complete; `requiredEnd` = max segment end (lag vs `resolved_safe_end` is freshness, not incompleteness).

- [ ] **Step 1: Write the failing test** (all 10 cases as `it.each` rows with explicit segment fixtures).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** the four exported functions. `hashJoinOk(a, b)`: `b.start_block === a.end_block + 1 && b.start_block_parent_hash === a.end_block_hash`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/ingest/coverage.ts tests/ingest/coverage.test.ts
git commit -m "feat: coverage segments with hash-join completeness"
```

---

### Task 4: rindexer `renderConfig`

**Files:**
- Create: `src/ingest/rindexer/renderConfig.ts`
- Create: `tests/ingest/renderConfig.test.ts`

**Interfaces:** `renderConfig(job: BoundedJob): string` — pure, returns YAML text.

Golden assertions on the output for a two-address USDC-style job:

- `project_type: no-code`
- `networks:` exactly one entry, `name: chainplot_1`, `chain_id: 1`, `rpc: ${RPC_URL}`
- `storage.postgres.enabled: true`; `graphql.enabled: false`; no `streams`, `chatbots`, `csv`, or docker-socket keys anywhere in the text
- one contract block per source: addresses quoted lowercase, explicit `start_block`/`end_block` = `jobStart`/`jobEnd`, `abi:` path, `include_events` exactly the declared signatures, `timestamp: true`
- deterministic: same input → byte-identical output (needed for plan digests)

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** using the `yaml` package (`stringify` of a plain object; addresses as quoted strings).
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/ingest/rindexer/renderConfig.ts tests/ingest/renderConfig.test.ts
git commit -m "feat: render bounded rindexer config"
```

---

### Task 5: `runBounded` + `stopAndQuiesce` with a fake rindexer binary

**Files:**
- Create: `src/ingest/rindexer/runBounded.ts`
- Create: `tests/ingest/runBounded.test.ts`
- Create: `tests/helpers/fakeRindexer.mjs`

**Behavior:**

1. Write `renderConfig(job)` to `<workDir>/rindexer.yaml` before spawn.
2. Spawn `${rindexerBin} start -p ${workDir} indexer` with env: `RPC_URL=job.rpcUrl`, `DATABASE_URL=job.databaseUrl`; strip other inherited secrets except `PATH`, `HOME`, `LANG`, `TMPDIR`.
3. `runBounded` resolves a `RunHandle` once the child is spawned.
4. Watch stdout for `/Historical indexing completed/` → set `completedLogSeen`, then the caller invokes `stopAndQuiesce`: SIGTERM, wait ≤ 10 s for exit, escalate SIGKILL.
5. Wall clock (`opts.wallClockMs`, default 30 min): on expiry SIGTERM the child and reject with `RpcError(true, "rpc job wall clock exceeded")` — job stays resumable, no coverage recorded.
6. Parent `SIGINT`/`SIGTERM` handlers (registered per apply-run, removed after) forward the signal to the child and exit non-zero; journal keeps recoverable state.
7. Child exit before the completed line → reject `RpcError(true, "rindexer exited before historic completion")`.

**Fake binary** (`tests/helpers/fakeRindexer.mjs`): parses `start -p <dir> indexer`; modes selected by env `FAKE_RINDEXER_MODE`: `complete` (print the log line, then sleep forever), `hang` (sleep forever, never print), `exit-early` (print nothing, exit 3). Used to test SIGTERM-after-line, wall clock, and early exit.

- [ ] **Step 1: Write the failing tests** (three modes; assert `completedLogSeen`, exit within timeout, rejection codes).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/ingest/rindexer/runBounded.ts tests/ingest/runBounded.test.ts tests/helpers/fakeRindexer.mjs
git commit -m "feat: bounded rindexer run with SIGTERM quiesce"
```

---

### Task 6: `inspectCoverage` — cursor evidence via `pg`

**Files:**
- Add dependency: `pnpm add pg` and `pnpm add -D @types/pg`
- Create: `src/ingest/rindexer/inspectCoverage.ts`
- Create: `tests/ingest/inspectCoverage.test.ts` (unit: classification + SQL shape)
- Create: `tests/ingest/live/inspectCoverage.live.test.ts` (env-gated)

**Evidence (M0-verified):** cursor table `rindexer_internal.{networkName}_{contractName}_{event}` (lowercased), columns `network text PK`, `last_synced_block numeric`. Event table `{networkName}_{contractName}_{event}` for row count.

**Behavior:**

1. `lastSyncedBlock`: `SELECT last_synced_block FROM rindexer_internal.<cursor> WHERE network = $1` — read as a **string** (pg returns `numeric` as string), parse with `BigInt` → `Number` only after range check; missing row → `null`.
2. `rowCount`: `SELECT count(*)::bigint AS n FROM <eventTable>` — identifiers are constructed only from validated lowercase `[a-z0-9_]` names (reject anything else at `BoundedJob` construction: `validation`).
3. Classification (pure function `classifyCoverage(lastSyncedBlock, rowCount, jobEnd)`):
   - `lastSyncedBlock === null` → `not_indexed`
   - `lastSyncedBlock < jobEnd` → `incomplete`
   - `lastSyncedBlock >= jobEnd && rowCount === 0` → `complete_empty` (A6)
   - else → `complete_with_rows`
4. Connection failure → `RpcError(true, ...)` → `transient_dependency`.
5. Close the pg pool; never leave connections open.

- [ ] **Step 1: Write the failing unit test** for `classifyCoverage` (4 statuses) and identifier validation (rejects `Drop;--`).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify PASS** (unit only; live test skips without env).
- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingest/rindexer/inspectCoverage.ts tests/ingest
git commit -m "feat: coverage inspection from rindexer cursor"
```

---

### Task 7: Snapshot exporter — DuckDB ATTACH → Parquet

**Files:**
- Create: `src/ingest/exporter.ts`
- Create: `tests/ingest/exporter.test.ts` (SQL generation, pure)
- Create: `tests/ingest/live/exporter.live.test.ts` (env-gated: needs Postgres with an rindexer-shaped table)

**Interfaces:**

```ts
export interface ExportResult {
  parquetPath: string;
  rowCount: number;
}
export async function exportEventTable(
  job: BoundedJob,
  outDir: string,
  duckdbPath: string, // disposable; .chainplot/duckdb/export.duckdb
): Promise<ExportResult>;
```

**SQL (M0 path 1, one coherent read):**

```sql
ATTACH '<databaseUrl>' AS pg_db (TYPE POSTGRES, READ_ONLY);
COPY (
  SELECT
    <chainId> AS chain_id,
    contract_address,
    "from" AS from_address,
    "to" AS to_address,
    value,
    tx_hash,
    CAST(block_number AS BIGINT) AS block_number,
    block_timestamp,
    block_hash,
    network,
    CAST(tx_index AS BIGINT) AS tx_index,
    log_index
  FROM pg_db.<network>_<contract>_<event>
) TO '<outDir>/<table>.parquet' (FORMAT PARQUET);
```

- Column list is derived from the ABI event inputs + the fixed envelope columns (M0-verified set); unknown ABI types fail `unsupported_capability` at `validate`/plan time, not here.
- Reserved/keyword input names (`from`, `to`) get explicit aliases; nested/tuple ABI types are refused (`unsupported_capability`) in M2 — only elementary types pass.
- Uniqueness gate in the same DuckDB session before COPY succeeds:

```sql
SELECT count(*) AS total,
       count(DISTINCT (contract_address, block_number, tx_hash, log_index)) AS distinct_keys
```

`total !== distinct_keys` → inspect whether conflicting rows differ in `block_hash`: yes → `source_inconsistent` (reorg duplicate); identical duplicates → deduplicate on the unique key (duplicate delivery must not produce duplicate snapshot rows, spec §9.2).

- `databaseUrl` never appears in the Parquet or manifest; connection string is passed via ATTACH only.
- DuckDB postgres extension: `INSTALL postgres; LOAD postgres;` — first host run needs network; the Dockerfile pre-installs it. Export child gets `DATABASE_URL` env; it is **not** the M1 query worker and never touches snapshot query paths.

- [ ] **Step 1: Write the failing test** for SQL text generation (casts present, `chain_id` literal, aliases, identifier validation) — pure function `buildExportSql(job, table)`.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** with `@duckdb/node-api` in a child process (`fork`-style, same pattern as `src/query/workerMain.ts` but a separate entry `src/ingest/exportWorkerMain.ts` that receives the database URL via env — the query worker env-stripping rule applies to the *query* worker, not this one).
- [ ] **Step 4: Run to verify PASS** (unit; live gated).
- [ ] **Step 5: Commit**

```bash
git add src/ingest/exporter.ts src/ingest/exportWorkerMain.ts tests/ingest
git commit -m "feat: export event tables to parquet via DuckDB postgres attach"
```

---

### Task 8: Plan generation — `ingest` and `refresh` intents

**Files:**
- Create: `src/plan/digest.ts`
- Create: `src/plan/generate.ts`
- Create: `tests/ingest/generatePlan.test.ts`

**Rules (spec §8, §9.2, §14.1):**

- Load project; exactly one `chain_source` (`validation` otherwise). Resolve `rpc_secret` → env var name; missing env → `missing_credentials`.
- `pinned`: probe finalized head (finality `finalized`) or head − depth (`confirmation_depth`); `end_block` beyond that → `policy_refused`, `pointer: "/event_sources/<i>/end"`.
- `follow_finalized`: chain finality must be `finalized` (else `unsupported_capability`); `resolved_safe_end` = finalized head; `< start_block` → `policy_refused`.
- Per source: `job_start = lastProvenCompleteBlock + 1`; `job_end = min(job_target_end, job_start + budget - 1)`; `job_start > job_end` → **no `ingest` action** for that source (no-op ingest, coverage unchanged). Budget split: `blocks_remaining > 0` after capping → plan stays intent `ingest`, `blocks_remaining` reported.
- `refresh` on a project where every source is `pinned` and complete → actions are `export` + `build_results` only, no RPC ingest (finalized-head probe still allowed only if some source is `follow_finalized`; all-pinned refresh does **no** RPC, spec §11).
- `state_assumptions` snapshot the current `lastProvenCompleteBlock` per source from `.chainplot/coverage.json` (missing file → all sources at `start_block - 1`).
- `plan_id = sha256(canonicalJson(plan without plan_id))`.
- Estimates that cannot be computed are `unknown`; never invented. Plan shows resolved interval and blocks remaining.

**Tests** (mock RPC server from Task 2 helpers; no live RPC):

1. Pinned end ≤ finalized → plan OK, `job_end = end_block`, actions include `ingest`.
2. Pinned `end_block` > finalized → `policy_refused`.
3. `confirmation_depth` chain, `end_block > head - depth` → `policy_refused`.
4. `follow_finalized` + `confirmation_depth` → `unsupported_capability` at plan time.
5. `follow_finalized` + `finalized`: `job_target_end` = finalized head; head < start → `policy_refused`.
6. Budget 10, range 35, no coverage → `job_end = start + 9`, `blocks_remaining = 25`.
7. Existing coverage proven to block X → `job_start = proven + 1` (resume, no rescan).
8. All sources pinned + already complete → plan has no `ingest` action and made **zero** RPC calls (assert mock server hit count).
9. Plan id stable: same inputs → same `plan_id`; any field change → different id.

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `generate.ts` + `digest.ts`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/plan tests/ingest/generatePlan.test.ts
git commit -m "feat: digest-bound ingest and refresh plans"
```

---

### Task 9: Journal, locks, `apply`

**Files:**
- Create: `src/runtime/journal.ts`
- Create: `src/runtime/locks.ts`
- Create: `src/plan/apply.ts`
- Create: `tests/ingest/apply.test.ts`

**Journal** (`.chainplot/runs/<idempotency-key>/`): `plan.json` (copy), `status.json` (`running | succeeded | failed | canceled`), `checkpoints.jsonl`, `child.pid`. Idempotency key defaults to `plan_id`; `--idempotency-key` overrides. Second `apply` with same key + **different** plan digest → `policy_refused`. Same key + same digest with `succeeded` status → return the recorded outcome without re-executing (A5). Same key + `running` → `policy_refused` (lock held).

**Locks:** `.chainplot/locks/ingest.lock` via `open(..., "wx")` with pid; released by `unlink` in `finally`. Advisory lock: `SELECT pg_try_advisory_lock(hashtext($1))` with `hashtext('<project_id>')`; false → `policy_refused`. PG lock is skipped (with a warning) when no `DATABASE_URL` is configured — publish-only flows never take it.

**`apply` sequence:**

1. Load plan file; validate against frozen `plan` schema.
2. Recompute `project_digest` from current `chainplot.yaml` → mismatch → `policy_refused` ("configuration drifted").
3. Recompute per-source `last_proven_complete_block` from `.chainplot/coverage.json` → mismatch with `state_assumptions` → `policy_refused` (state drifted; re-plan).
4. Acquire local lock + advisory lock.
5. Idempotency check against journal (above).
6. Execute `actions` in order:
   - `ingest`: `renderConfig` → `runBounded` → on `Historical indexing completed` → `stopAndQuiesce` → `inspectCoverage`. Status `complete_empty|complete_with_rows` → fetch 3 headers (`jobStart-1`, `jobStart`, `jobEnd`), append segment via `hashJoinOk` against the tail (broken join → `source_inconsistent`, segment **not** appended, run fails, prior coverage intact). Status `incomplete|not_indexed` → run fails `transient_dependency`, no segment.
   - `export`: `exportEventTable` per source with new coverage.
   - `build_results`: reuse M1 build pipeline over the exported snapshot; **promotion gate**: `isComplete` per source must be true over `[start_block, required_end]`, else `policy_refused` naming source + missing range.
7. Write updated `.chainplot/coverage.json`; journal status `succeeded` with release path.
8. Release locks in `finally`.

**Tests** (offline, fake adapter + fake binary where needed):

- Digest drift: edit `chainplot.yaml` after `plan` → `apply` fails `policy_refused`, nothing executed.
- State drift: coverage file changed after `plan` → `policy_refused`.
- Same key + same digest, already succeeded → no second execution (counter in fake adapter).
- Same key + different digest → `policy_refused`.
- Concurrent apply → `policy_refused` from local lock.
- Hash-join break injected via fake header fetch → `source_inconsistent`, coverage file unchanged.
- Incomplete pinned (fake adapter reports cursor < end) → run fails, no segment, no release.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** `journal.ts`, `locks.ts`, `apply.ts`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/runtime src/plan/apply.ts tests/ingest/apply.test.ts
git commit -m "feat: apply plans with journal, locks, coverage recording"
```

---

### Task 9: CLI `plan`, `apply`, `refresh`

**Files:**
- Create: `src/cli/commands/plan.ts`, `src/cli/commands/apply.ts`, `src/cli/commands/refresh.ts`
- Modify: `src/cli/run.ts` (register; capabilities `commands` += `plan`, `apply`, `refresh`)
- Create: `tests/cli/plan.test.ts`, `tests/cli/refresh.test.ts`

**Command surface:**

- `plan --intent ingest|refresh|build|publish [--json|--jsonl]` — `build|publish` → `unsupported_capability` (M3/M4). Read-only probes only; writes only the plan file.
- `apply --plan <path|id> [--idempotency-key <key>] [--json|--jsonl]`
- `refresh [--publish-target <id>] [--json|--jsonl]` — sugar: classify authorization (Task below), generate `plan --intent refresh`, apply.

**`refresh` authorization (spec §9.2):**

- Find last successfully applied plan in the journal. Compare its stored project copy against the current one:
  - Only `models`/`queries`/`dashboards` content changed → allowed; actions become `export` + `build_results` (no ingest for pinned sources).
  - `addresses`, `start_block`, `end`, public columns, `publish_targets`, or chain identity changed → `policy_refused` (out-of-band `plan` + `apply` required).
- No last applied plan → derive from the project file alone: first `follow_finalized` run from `start_block` allowed; nothing else widens.
- All sources `pinned` → refresh does zero RPC (A16). Any `follow_finalized` source → exactly one finalized-head probe.
- `--publish-target` must name a target already in `chainplot.yaml`, else `policy_refused`.

**Tests:**

- Pinned complete project + dashboard title edit → `refresh` succeeds, actions contain no `ingest`.
- Address edit → `refresh` fails `policy_refused`.
- `--publish-target nope` → `policy_refused`.
- All-pinned refresh makes no HTTP calls (mock server request counter = 0).
- `plan --intent build` → `unsupported_capability`.

- [ ] **Step 1: Write failing tests.**
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** commands + `src/plan/refresh.ts`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/cli src/plan tests/cli
git commit -m "feat: plan, apply, refresh commands"
```

---

### Task 10: Progress events and `runs list|show|cancel`

**Files:**
- Create: `src/runtime/journal.ts` (if not fully landed in Task 8, finish here)
- Create: `src/cli/commands/runs.ts`
- Create: `tests/cli/runs.test.ts`

**Behavior:**

- `--jsonl` on `apply`/`refresh`: one `progress` event per stage transition (`plan_verified`, `ingest_started`, `ingest_completed`, `coverage_recorded`, `export_completed`, `release_written`), then the final result object. Events validate against `progress.schema.json`. No invented completion percentages.
- `runs list` → journal entries: key, plan id, intent, status, started/updated timestamps.
- `runs show <key>` → plan copy + status + checkpoints.
- `runs cancel <key>` → write `cancel_requested`; a running `apply` checks the flag between stages and after each ingest log line, forwards SIGTERM to the child, marks `canceled`, keeps coverage written so far (recoverable state). Cancel of a succeeded run → `validation`.

- [ ] **Step 1: Write failing tests** (list/show roundtrip; cancel flag observed by a fake long stage).
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/runs.ts src/runtime tests/cli/runs.test.ts
git commit -m "feat: run journal commands and cooperative cancel"
```

---

### Task 11: Ingest template, Compose, Dockerfile

**Files:**
- Create: `templates/ingest-transfers/chainplot.yaml`
- Create: `templates/ingest-transfers/abis/ERC20.json`
- Create: `templates/ingest-transfers/.env.example` (`RPC_URL=`, `DATABASE_URL=` — comments only, no real endpoints)
- Create: `templates/ingest-transfers/compose.yaml`
- Create: `templates/ingest-transfers/Dockerfile`
- Create: `templates/ingest-transfers/.dockerignore`
- Modify: `src/cli/commands/templates.ts`, `src/cli/commands/init.ts` (register `ingest-transfers`; `init` copies `compose.yaml` + `Dockerfile` for ingest templates)
- Modify: `src/cli/commands/capabilities.ts` (`templates` list)
- Create: `tests/cli/initIngest.test.ts`

**`chainplot.yaml` (template):** one chain source (`finality: finalized`, `rpc_secret: RPC_URL`), one event source (USDC address, `start_block: 18600000`, `end: {mode: pinned, block: 18600010}` — small, cheap, matches M0 evidence), `policy.block_budget: 100000`, one directory publish target. Queries/dashboards mirror the fixture template so `build` works after apply.

**`compose.yaml`:** `postgres` (`postgres:16-alpine`, healthcheck, named volume) + `producer` (`build: .`, `platform: linux/amd64`, `env_file: .env`, project dir mounted at `/workspace`, `command: sleep infinity` — the agent execs CLI commands inside; no docker.sock; no ports exposed beyond loopback needs).

**`Dockerfile`:**

```dockerfile
FROM ghcr.io/joshstevens19/rindexer@sha256:9b33da8cea740b74ebfdfd3932682e8ceab79cbcf2eb3a7ca0863ac413794dd7 AS rindexer
FROM node:22-bookworm-slim
# ... install pnpm, copy package.json + lock, pnpm install --frozen-lockfile
# ... copy source, pnpm build
# COPY --from=rindexer <binary-path-in-image> /usr/local/bin/rindexer
# RUN node --input-type=module -e "install duckdb postgres extension into /app/.duckdb" && ENV DUCKDB_EXTENSION_DIR
```

- [ ] **Step 1: Locate the rindexer binary path inside the pinned image** — `docker create` + `docker export` (or `docker inspect`) the pinned digest; record the path and the fact in `docs/compatibility.md`. This is a verification step, not a guess.
- [ ] **Step 2: Write failing test** — `init --template ingest-transfers` produces `compose.yaml`, `Dockerfile`, `.env.example`, `chainplot.yaml`; `validate` passes on the scaffold offline (no RPC needed for `validate`).
- [ ] **Step 3: Implement template + init wiring.**
- [ ] **Step 4: Run to verify PASS** (`pnpm test`).
- [ ] **Step 5: Build the image and smoke it**: `docker build -t chainplot-producer templates/ingest-transfers && docker run --rm chainplot-producer capabilities --json` parses. Record Node/rindexer paths in `docs/compatibility.md`.
- [ ] **Step 6: Commit**

```bash
git add templates src/cli tests/cli/initIngest.test.ts docs/compatibility.md
git commit -m "feat: ingest template with Compose and producer Dockerfile"
```

---

### Task 12: Live-gated end-to-end ingest + docs

**Files:**
- Create: `tests/ingest/live/e2e.live.test.ts`
- Modify: `docs/compatibility.md`
- Modify: `README.md` (status line + commands table)

**Gate:** `CHAINPLOT_TEST_DATABASE_URL` (our Postgres 16) **and** `RPC_URL` (archive-capable) both set; otherwise `describe.skip`. No URLs in the repo — the test reads env only.

**Scenario (M0 replay through the product):**

1. `init --template ingest-transfers` into a temp dir; `.env` from env vars.
2. `plan --intent ingest --json` → plan with `job_start: 18600000`, `job_end: 18600010`.
3. `apply --plan <id> --json` → rindexer indexes 11 blocks; coverage segment `complete_with_rows` (USDC) recorded with 3 header hashes; snapshot parquet exists; release written.
4. Re-`apply` same plan + key → no duplicate rows (row count unchanged), status returned from journal (A5).
5. `plan --intent ingest` again → `job_start > job_end` → no-op plan, coverage unchanged.
6. Truncation probe: hand-edit coverage to drop the segment → `build` fails `policy_refused` (incomplete cannot be promoted — the M2 gate).
7. `refresh` on the pinned complete project → succeeds with zero RPC requests (A16 offline half).

Record in `docs/compatibility.md`: rindexer binary path in image, image build date, live test evidence (row counts), any deviation from this plan with a one-line reason.

- [ ] **Step 1: Write the live test (skipped by default).**
- [ ] **Step 2: Run with env set; fix product code until green.**
- [ ] **Step 3: Run `pnpm test` without env — all skip, suite green.**
- [ ] **Step 4: Update docs.**
- [ ] **Step 5: Commit**

```bash
git add tests/ingest/live docs/compatibility.md README.md
git commit -m "test: live-gated ingest end-to-end and M2 docs"
```

---

## Verification checklist (M2 gate)

- [ ] `pnpm test` green with no env (live tests skip).
- [ ] `pnpm test` green with `RPC_URL` + `CHAINPLOT_TEST_DATABASE_URL` set (live path).
- [ ] Incomplete pinned range cannot produce a release (`policy_refused`).
- [ ] Hash-join break → `source_inconsistent`, coverage not corrupted.
- [ ] Two concurrent applies → one `policy_refused`.
- [ ] No tracked file contains an RPC URL or provider hostname; `.env` gitignored.
- [ ] `capabilities` lists exactly the implemented commands.
- [ ] No docker.sock in any compose/Dockerfile/test.
