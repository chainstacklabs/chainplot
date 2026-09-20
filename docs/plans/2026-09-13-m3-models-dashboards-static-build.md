# Chainplot M3 Models, Dashboards, Static Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the full local build: SELECT model graph materialized in dependency order, `plan --intent build`, a static viewer (React + Vite + ECharts) that renders cached results with freshness/coverage/finality chips, provenance + sanitized `source/` in the release, and `serve` on loopback. Gate: the built dashboard works with producer, database, RPC, and CDN unavailable.

**Architecture:** Models are SELECT-only SQL files materialized as DuckDB tables inside the same isolated worker that runs queries (topo order, cycles refused at `validate`). `build` extends the M1 results-only release to the §16.1 release layout minus `latest.json` (M4): `index.html`, `assets/` (prebuilt viewer bundle), `release.json`, `dashboards/`, `results/`, `datasets/<id>/manifest.json` + `tables/*.parquet`, `source/`. The viewer bundle is built once from `viewer/` (React + Vite + ECharts) and committed; `build` copies it — no node toolchain at user runtime, no CDN.

**Tech Stack:** Unchanged for the CLI. Viewer adds `react`, `react-dom`, `echarts`, `vite`, `@vitejs/plugin-react` in `viewer/package.json` (own lockfile, `viewer/node_modules` gitignored).

**Spec:** `docs/specs/2026-09-12-chainplot-design.md` §8 (change classes), §12 (wide integers, sort keys), §13 (models/queries), §14 (isolation/limits), §15 (viewer), §16.1 (release layout), §9.1 (`serve` loopback-only).

## Global Constraints

- All M1/M2 constraints hold: envelope, closed error codes, `--json`, offline `validate`, uint256 decimal strings, no `ORDER BY` on raw amount columns, DuckDB worker isolation (snapshot files + temp dir only, stripped env, external access disabled).
- Models are `SELECT` only. The worker rejects any model SQL whose first keyword is not `SELECT` (no DDL/DML/COPY/ATTACH/PRAGMA). Cycles fail `validate` with `validation`.
- `build` never talks to RPC. Promotion gate (M2) still applies to ingest projects.
- `plan --intent build` makes no network probes and authorizes only `build_results` (+ `export` never). `plan --intent publish` stays `unsupported_capability` (M4).
- Viewer: no third-party CDN, no user JavaScript formatters, no arbitrary HTML. Sort of a raw-amount column uses numeric compare of the decimal string (or a published sort key), never `localeCompare`. A control must not imply it can fetch missing history or rerun SQL.
- `serve` binds `127.0.0.1` only; refuses `0.0.0.0`; serves a directory read-only.
- Release layout (M3 subset of §16.1, no `latest.json` yet):
  `index.html`, `assets/`, `release.json`, `dashboards/<id>.json`, `results/<query>.json`, `datasets/<id>/manifest.json`, `datasets/<id>/tables/*.parquet`, `source/`.
- `source/` is an explicit allowlist: `chainplot.yaml`, `abis/`, `models/`, `queries/`, `tests/`, `schemas/` (project-local). Never `.env`, `.chainplot/`, `dist/`, run logs, absolute machine paths.
- Do not add `.markdownlint.yaml`. Do not commit viewer `node_modules`.

## Later plans (out of this file)

M4: publish targets (directory + S3), `latest.json` conditional promotion, fork with SSRF rules, dataset modes per manifest, S3 conditional-write probe.
M5: examples, A1–A16 full pass, multi-arch smoke.

---

## File structure

| Path | Responsibility |
|---|---|
| `src/project/modelGraph.ts` | Dep resolution, cycle detection, topo order |
| `src/query/runQuery.ts` | Extend worker request: `models: {id, sql}[]` materialized before the query |
| `src/query/workerMain.ts` | Materialize models in order (SELECT-only), then run query |
| `src/publish/writeRelease.ts` | Full release: models, dashboards, static assets, provenance, `source/` |
| `src/publish/sourceBundle.ts` | Allowlist copy for `source/` |
| `src/cli/commands/serve.ts` | Loopback static server |
| `src/cli/commands/plan.ts` | Accept `--intent build` |
| `src/plan/generate.ts` | `build` intent: no probes, `build_results` action only |
| `viewer/` | React + Vite + ECharts viewer source; committed bundle in `viewer/dist/` |
| `schemas/release.schema.json` | Extend: dashboards, generated_at, snapshots, coverage |
| `schemas/manifest.schema.json` | Extend: coverage, finality label, freshness |

---

## Shared types (lock these names)

```ts
// src/project/modelGraph.ts
export interface ModelNode {
  id: string;
  file: string;
  depends_on: string[];
}

// returns model ids in dependency order (deps first)
export function topoSortModels(models: ModelNode[]): string[]; // throws CommandError validation on cycle/unknown dep
```

```ts
// worker request extension (src/query/runQuery.ts QueryRequest)
export interface QueryRequest {
  sql: string;
  tables: Record<string, string>;
  analysisTimestamp: string;
  rawAmountColumns: string[];
  rowLimit: number;
  models?: { id: string; sql: string }[]; // materialized in array order before sql
}
```

```ts
// release.json (extended)
export interface ReleaseDocument {
  schema_version: 1;
  project_id: string;
  mode: "results_only" | "dataset_included" | "dataset_referenced";
  queries: string[];
  dashboards: string[];
  generated_at: string;       // build time (UTC)
  snapshots: { dataset_id: string; snapshot_id: string }[];
  coverage: { source_id: string; start_block: number; end_block: number; status: string }[];
  finality: { policy: string } | { policy: "confirmation_depth"; depth: number } | null;
}
```

---

### Task 1: Model graph — deps, cycles, topo order

**Files:** Create `src/project/modelGraph.ts`, `tests/project/modelGraph.test.ts`; modify `src/project/validate.ts` (validate model deps exist + acyclic; model `expected columns` field optional string array in project schema + types).

Cases: linear chain; diamond; unknown dep → `validation`; self-dep → cycle; two-node cycle; order correct (deps before dependents); models depending on datasets are allowed (dataset ids are roots).

- [ ] Failing test → implement → pass → commit `feat: model graph validation and topo order`

### Task 2: Model materialization in the DuckDB worker

**Files:** Modify `src/query/runQuery.ts` (accept `models`), `src/query/workerMain.ts` (materialize in order: `CREATE TABLE <id> AS (<sql>)`; first-keyword-SELECT enforcement), `tests/query/models.test.ts`.

Cases: model consumed by query (`WITH`-free reuse); model on top of model in order; non-SELECT model SQL → worker fails `validation`; model failure fails the query with the model id in the message; existing no-model requests unchanged; raw-amount `ORDER BY` guard still applies to query SQL.

- [ ] Failing test → implement → pass → commit `feat: materialize SELECT models in the DuckDB worker`

### Task 3: `plan --intent build` and apply build-only

**Files:** Modify `src/plan/generate.ts` (intent `build`: require no `event_sources` ingest — sources may exist but no ingest/export actions; actions = `[build_results]`; zero RPC probes; state assumptions from coverage), `src/cli/commands/plan.ts` (accept `build`; `publish` stays unsupported), `tests/plan/buildIntent.test.ts`.

Cases: build plan on fixture project → ok, no RPC calls, actions exactly `[build_results]`; apply executes build only; `plan --intent publish` → `unsupported_capability`; build plan on ingest project with incomplete coverage → apply refused by the promotion gate (M2 behavior, regression guard).

- [ ] Failing test → implement → pass → commit `feat: plan --intent build`

### Task 4: Viewer bundle (React + Vite + ECharts)

**Files:** Create `viewer/package.json`, `viewer/vite.config.ts`, `viewer/tsconfig.json`, `viewer/src/main.tsx`, `viewer/src/App.tsx` (dashboards, panels, chips, table sort, KPI, line/bar via ECharts), `viewer/index.html`; commit built `viewer/dist/`; `.gitignore` += `viewer/node_modules`.

Behavior: fetch `release.json` → for each dashboard fetch `dashboards/<id>.json` → per panel fetch `results/<query>.json`; chips: freshness (`generated_at`), coverage (from release `coverage`), finality label (confirmation-based labeled), dataset mode. Table sort on raw-amount columns uses numeric compare of decimal strings (BigInt compare, sign-aware); KPI shows exact decimal string. Works under a base path (relative fetches only). No CDN, no eval, no user HTML.

- [ ] Scaffold + implement viewer → `pnpm build` in `viewer/` → commit `feat: viewer bundle (React + Vite + ECharts)`

### Task 5: Full build — static release layout, provenance, source/

**Files:** Modify `src/publish/writeRelease.ts` (models re-export, dashboards data, copy viewer bundle → `index.html` + `assets/`, provenance in `release.json`, coverage/finality/freshness into manifest), create `src/publish/sourceBundle.ts` (allowlist copy), extend `schemas/release.schema.json` + `schemas/manifest.schema.json`, `tests/build/fullBuild.test.ts`.

Cases: fixture project build produces the full layout (index.html, assets/, release.json with dashboards+coverage, dashboards/<id>.json, results/, datasets/<id>/{manifest.json,tables/*.parquet}, source/ with allowlisted files only); `source/` never contains `.env` or `.chainplot`; dashboard title change → rebuild reflects it, no ingest (A2); release.json validates against the frozen schema; manifest carries coverage + finality label + freshness.

- [ ] Failing test → implement → pass → commit `feat: full static build with provenance and source bundle`

### Task 6: `serve` — loopback static preview

**Files:** Create `src/cli/commands/serve.ts`, register in `run.ts` + capabilities, `tests/cli/serve.test.ts`.

Behavior: `serve [--dir <path>] [--port <n>]`; binds `127.0.0.1` only (refuse/ignore other hosts — no `--host` flag at all); serves index.html + static files with content types; path traversal rejected (`..` segments resolve inside root); `--json` prints `{url}` and keeps serving until SIGINT (test uses an ephemeral port + real HTTP fetch).

- [ ] Failing test → implement → pass → commit `feat: serve loopback static preview`

### Task 7: Acceptance checks + docs

**Files:** Modify `README.md`, `docs/compatibility.md`; `tests/cli/a2.e2e.test.ts`.

A2: init fixture → build → edit dashboard title → build again → release reflects new title, no network, no ingest actions. A15 regression: fixture quickstart still green with network disabled. A9 groundwork: served release renders via plain HTTP fetch of index.html + release.json (no other services).

- [ ] Tests → docs → commit `test: A2 presentation rebuild and served-release checks`

---

## Verification checklist (M3 gate)

- [ ] `pnpm test` green, no env, no network.
- [ ] Fixture build output renders via `serve` with only local HTTP (A9 groundwork).
- [ ] Cycle in models → `validate` fails before any build.
- [ ] `source/` allowlist: no `.env`, no `.chainplot`, no absolute paths.
- [ ] Viewer: no CDN references in committed bundle (`grep -r "https://" viewer/dist` → only license comments/none).
- [ ] `capabilities` lists `serve`; `plan --intent build` works; `--intent publish` still `unsupported_capability`.
