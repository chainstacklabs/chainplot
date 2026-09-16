# Chainplot M5 Examples and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three v0.1 examples, run A1–A16, smoke the Compose Dockerfile on Linux x86-64 and ARM64, and finish docs (capability matrix, upstream notices, dataset license statements). Gate: fix interface and correctness problems before new source types or a human editor.

**Architecture:** Examples live in `examples/` as ordinary Chainplot projects (committed `chainplot.yaml` + queries; snapshots are produced by running the pipeline, not committed — each example README documents the run command). Acceptance A1–A16 map to existing automated tests plus a small number of new e2e tests; the matrix in `docs/acceptance.md` records evidence per ID.

**Spec:** `docs/specs/2026-09-12-chainplot-design.md` §18 (definition of done), §19 (M5), §14.1, §17 (Compose operation).

## Global Constraints

- All M1–M4 constraints hold. No RPC URLs, endpoints, or keys in tracked files.
- Live examples run against the operator's `.env` (RPC_URL, DATABASE_URL) and a local Postgres; they are documented runbooks, not CI tests.
- rindexer binary is linux/amd64-only: multi-arch smoke = Dockerfile builds on both architectures; rindexer execution is amd64-only (recorded limitation, follow-on: upstream arm64 image).

---

### Task 1: M2 live RPC e2e through the product

**Files:** `tests/ingest/live/e2e.live.test.ts` (already written, env-gated on `CHAINPLOT_TEST_DATABASE_URL` + `RPC_URL`).

Run with a disposable Docker Postgres (`docker run -d --name chainplot-test-pg -p 127.0.0.1:5433:5432 postgres:16-alpine`), `CHAINPLOT_TEST_DATABASE_URL=postgresql://chainplot:chainplot@localhost:5433/chainplot`, `RPC_URL` from `.env`. Scenario: plan → apply (92 USDC rows) → idempotent re-apply → no-op plan → truncation gate. Record evidence in `docs/compatibility.md`.

- [ ] Run green → commit `test: M2 live RPC e2e green`

### Task 2: Example 1 — transfer activity (full ingest pipeline)

**Files:** Create `examples/transfer-activity/` (chainplot.yaml, abis/, queries/, dashboards/, tests/, README.md) + `examples/README.md` index. Run end-to-end: init-style scaffold → plan → apply (real rindexer, USDC 18600000–18600010) → build → serve. Evidence in `docs/acceptance.md` (A1).

- [ ] Example runs green → commit `feat: transfer activity example`

### Task 3: Example 2 — protocol deposits/withdrawals (WETH)

**Files:** Create `examples/weth-activity/` — WETH9 (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`), events `Deposit(address,uint256)` + `Withdrawal(address,uint256)`, small pinned range, two queries (deposits count/sum, withdrawals count/sum), dashboard with KPI + table. Same live run path as Task 2.

- [ ] Example runs green → commit `feat: deposit/withdrawal example (WETH)`

### Task 4: Example 3 — fork of a published dataset

**Files:** `examples/fork/README.md` documenting the flow; the A10 e2e already covers the mechanics. Publish example 1 to the R2 target (or local dir), fork it as a second agent, add a new query/dashboard, build offline.

- [ ] Documented + run → commit `docs: fork example`

### Task 5: A1–A16 acceptance matrix

**Files:** Create `docs/acceptance.md` mapping every A-id to its evidence (test file + status). New tests where gaps remain:

- A1 (agent creates dashboard from ABI + bounded fixture): covered by fixture quickstart + examples.
- A3 (earlier history / another contract = explicit additional work): test that widening `start_block` requires a new ingest plan and `refresh` refuses — extend `tests/cli/ingestCommands.test.ts`.
- A4 (kill producer mid-indexing): covered by runBounded wall-clock/early-exit tests + journal resume; add an integration note.
- A12 (malicious filenames/SQL): fork path traversal test exists; add a model-SQL rejection test (non-SELECT model refused — exists in models.test.ts).
- A13 (limits): size-cap test exists; add block-budget split test (exists in planApply).
- A14 (missing secrets): missing_credentials tests exist.
- A6/A7/A8/A5/A16/A15/A9/A2/A10/A11: existing tests (record pointers).

- [ ] Matrix complete, gaps closed → commit `test: A1–A16 acceptance matrix`

### Task 6: Capability matrix + license docs

**Files:** `docs/capabilities.md` (commands × status, sources, targets, chart types, limits table from §14.1); `NOTICES.md` (upstream: rindexer MIT, DuckDB MIT, ECharts Apache-2.0, React MIT, AWS SDK Apache-2.0); README dataset-license note (already in publish targets).

- [ ] Docs → commit `docs: capability matrix and upstream notices`

### Task 7: Multi-arch Compose smoke

**Files:** `docs/compatibility.md` evidence.

`docker build --platform linux/amd64` (already proven in M2 live run) + `docker build --platform linux/arm64` (build-only smoke; rindexer binary cannot execute on arm64 — documented limitation, no arm64 upstream image). Record both.

- [ ] Both builds green → commit `test: multi-arch Dockerfile smoke`

### Task 8: Final verification

`pnpm test` green; live S3 + live RPC suites green; `docs/acceptance.md` complete; README final status.

- [ ] Commit `docs: M5 complete`

---

## Verification checklist (M5 gate = v0.1 done)

- [ ] A1–A16 pass on fixtures (A11 via Compose), live smoke opt-in and bounded.
- [ ] Three examples run from their READMEs.
- [ ] Capability matrix matches `capabilities` output.
- [ ] Multi-arch evidence recorded.
- [ ] No secrets or endpoint URLs in tracked files.
