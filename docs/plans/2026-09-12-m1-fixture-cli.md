# Chainplot M1 Fixture CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `chainplot` CLI that an agent can learn from `--json` help and JSON Schema, init a fixture project, validate it offline, query a committed Parquet snapshot with DuckDB, run assertions, and `build` cached query results — with network disabled.

**Architecture:** One Node package. JSON Schema in `schemas/` is the source of truth. CLI commands call `src/project` and `src/query`; DuckDB runs in a forked child that sees snapshot files only. No rindexer, Postgres, S3, viewer HTML, or `plan --intent ingest` in this plan.

**Tech Stack:** Node.js 22 or 24 LTS (`engines.node`: `>=22 <27`), pnpm 11. TypeScript, vitest, ajv, yaml, commander, and `@duckdb/node-api` (neo) versions come from `pnpm add` in Task 1 and are recorded in `docs/compatibility.md` plus `pnpm-lock.yaml`. Do not use the deprecated `duckdb` package.

**Spec:** `docs/specs/2026-09-12-chainplot-design.md` (M1 plus the local DuckDB/uint256 pin from M0). M2+ plans cover ingest, Compose, viewer, S3, fork.

## Global Constraints

- CLI name is `chainplot`. Noninteractive. `--json` emits exactly one result object on stdout; diagnostics on stderr.
- Result envelope: `{ schema_version: 1, ok, command, data, warnings, error }`. `schema_version` is an integer.
- `error.code` is only: `validation`, `missing_credentials`, `unsupported_capability`, `policy_refused`, `source_inconsistent`, `transient_dependency`, `internal`.
- Unknown YAML/JSON fields fail validation. `format_version` other than `1` → `unsupported_capability`.
- Dataset-only path: no RPC, no Postgres. A15: fixture quickstart works with network disabled.
- Wide integers in JSON are decimal strings. Use DuckDB `getRowsJson()`. No JavaScript `number` for on-chain integers.
- `ORDER BY` on a raw decimal-string amount column is forbidden.
- DuckDB worker: child process, snapshot files + temp dir only; strip RPC/PG/S3 env.
- M1 `build` emits `release.json`, `manifest.json`, and typed query results. No HTML, no viewer assets.
- `capabilities` advertises **implemented** commands and kinds only. Do not claim rindexer or S3 until those plans land.
- One package. pnpm. MIT already in `LICENSE`.
- Do not add `.markdownlint.yaml`.

## Later plans (out of this file)

M2: rindexer adapter, coverage, plan/apply/refresh ingest, Compose, remaining M0 live probes (empty-range evidence, S3 conditional write, header columns).
M3: SELECT models, viewer, `serve`, full `build`.
M4: directory + S3 publish, fork, `latest.json`.
M5: examples, A1–A16, multi-arch smoke.

---

## File structure

| Path | Responsibility |
|---|---|
| `package.json` | Name `chainplot`, bin, engines, pnpm scripts |
| `pnpm-lock.yaml` | Software lock |
| `tsconfig.json` | `strict`, `NodeNext`, `outDir: dist` |
| `src/cli/main.ts` | Process entry: parse argv, print JSON, `process.exit` |
| `src/cli/run.ts` | `runCli(argv, opts) → CommandResult` (testable, no `process.exit`) |
| `src/cli/envelope.ts` | `okResult`, `failResult`, `ErrorCode` |
| `src/cli/commands/capabilities.ts` | `capabilities` |
| `src/cli/commands/schemaShow.ts` | `schema show <kind>` |
| `src/cli/commands/templates.ts` | `templates list` |
| `src/cli/commands/init.ts` | `init --template --output` |
| `src/cli/commands/validate.ts` | `validate` |
| `src/cli/commands/describe.ts` | `dataset describe` |
| `src/cli/commands/query.ts` | `query --file --snapshot` |
| `src/cli/commands/test.ts` | `test` |
| `src/cli/commands/build.ts` | `build` |
| `src/project/load.ts` | Read `chainplot.yaml`, parse YAML |
| `src/project/validate.ts` | Ajv + graph checks |
| `src/project/types.ts` | Project document types |
| `src/query/workerMain.ts` | Child entry: SQL in, JSON rows out |
| `src/query/runQuery.ts` | Fork worker, enforce limits, parse JSON |
| `src/query/forbidOrderByRaw.ts` | Reject `ORDER BY` on raw-amount columns |
| `schemas/*.schema.json` | One file per kind |
| `templates/fixture-transfers/` | Init scaffold + committed Parquet |
| `tests/cli/*.test.ts` | Command tests |
| `tests/helpers/run.ts` | `runCliJson` helper |
| `docs/compatibility.md` | DuckDB/Node pin evidence from Task 1 |

---

## Shared types (lock these names)

Every later task uses these. Define them in Task 1 and do not rename.

```ts
// src/cli/envelope.ts
export const SCHEMA_VERSION = 1 as const;

export type ErrorCode =
  | "validation"
  | "missing_credentials"
  | "unsupported_capability"
  | "policy_refused"
  | "source_inconsistent"
  | "transient_dependency"
  | "internal";

export interface CommandError {
  code: ErrorCode;
  message: string;
  resource_id: string | null;
  pointer: string | null;
  retryable: boolean;
  suggested_next: string | null;
}

export interface CommandResult<T = unknown> {
  schema_version: typeof SCHEMA_VERSION;
  ok: boolean;
  command: string;
  data: T | null;
  warnings: string[];
  error: CommandError | null;
}

export function okResult<T>(command: string, data: T): CommandResult<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings: [],
    error: null,
  };
}

export function failResult(
  command: string,
  error: CommandError,
): CommandResult<null> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    data: null,
    warnings: [],
    error,
  };
}
```

```ts
// src/cli/run.ts
export interface RunCliOptions {
  cwd: string;
}

export function runCli(
  argv: string[],
  opts: RunCliOptions,
): Promise<CommandResult>;
```

`argv` is the args after the binary name, e.g. `["capabilities", "--json"]`.

```ts
// tests/helpers/run.ts
import { runCli, type CommandResult } from "../../src/cli/run.js";

export async function runCliJson(
  argv: string[],
  cwd: string,
): Promise<CommandResult> {
  return runCli(argv, { cwd });
}
```

Schema kinds (exact set for M1 `schema show` and `capabilities`):

`project`, `plan`, `result`, `progress`, `release`, `manifest`, `latest`, `coverage`, `lock`

M1 implements behavior for `project`, `result`, `release`, `manifest`, `lock`. The others still have schemas so `schema show` works; runtime writers for `plan` / `progress` / `latest` / `coverage` wait for M2/M4.

---

### Task 1: Scaffold, envelope, capabilities

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli/envelope.ts`
- Create: `src/cli/run.ts`
- Create: `src/cli/main.ts`
- Create: `src/cli/commands/capabilities.ts`
- Create: `tests/helpers/run.ts`
- Create: `tests/cli/capabilities.test.ts`
- Create: `docs/compatibility.md`

**Interfaces:**
- Consumes: nothing
- Produces: `runCli`, `okResult`, `failResult`, `CommandResult`, `ErrorCode`, `SCHEMA_VERSION`; `capabilities` data shape below

Capabilities `data`:

```ts
export interface CapabilitiesData {
  cli_version: string;
  schema_kinds: string[];
  commands: string[];
  sources: string[];
  publish_targets: string[];
  chart_types: string[];
  sql_modes: string[];
}
```

M1 values: `schema_kinds` = the nine kinds; `commands` = `["capabilities"]` after this task (later tasks append); `sources` = `[]`; `publish_targets` = `[]`; `chart_types` = `["line", "bar", "kpi", "table"]`; `sql_modes` = `["snapshot"]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/capabilities.test.ts
import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("capabilities", () => {
  it("prints one JSON object with integer schema_version", async () => {
    const result = await runCliJson(["capabilities", "--json"], cwd);
    expect(result.schema_version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.command).toBe("capabilities");
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      schema_kinds: expect.arrayContaining(["project", "progress", "latest"]),
      sql_modes: ["snapshot"],
      sources: [],
      publish_targets: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/capabilities.test.ts`

Expected: FAIL (no `package.json` / `runCli` yet). If pnpm is missing, install pnpm 11 then retry.

- [ ] **Step 3: Write minimal implementation**

`package.json` (exact fields; pin versions with `pnpm add` in this step, do not invent floating `latest`):

```json
{
  "name": "chainplot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22 <27" },
  "packageManager": "pnpm@11.24.0",
  "bin": { "chainplot": "./dist/cli/main.js" },
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Install: `pnpm add commander yaml ajv @duckdb/node-api` and `pnpm add -D typescript vitest @types/node`. Record the resolved versions in `docs/compatibility.md` (Node `process.version`, `pnpm -v`, `@duckdb/node-api` version from lockfile). Prove DuckDB neo loads:

```ts
import { DuckDBInstance } from "@duckdb/node-api";
const db = await DuckDBInstance.create(":memory:");
const conn = await db.connect();
const reader = await conn.runAndReadAll("select 1 as n");
```

Implement `envelope.ts` as in Shared types. `run.ts` uses commander: require `--json` for M1 (if missing, still print JSON error `validation` on stdout so agents never get text-only stdout). `main.ts`:

```ts
import { runCli } from "./run.js";

const result = await runCli(process.argv.slice(2), { cwd: process.cwd() });
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(result.ok ? 0 : 1);
```

`capabilities.ts` returns `okResult("capabilities", { ... })`. Register the command in `run.ts`.

Update `.gitignore` if needed: `node_modules/`, `dist/`, `coverage/`. Keep existing `.chainplot/` and `.env` ignores.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`

Expected: PASS. `docs/compatibility.md` lists Node, pnpm, `@duckdb/node-api`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src tests docs/compatibility.md .gitignore
git commit -m "feat: add chainplot CLI capabilities --json"
```

---

### Task 2: JSON Schema files and `schema show`

**Files:**
- Create: `schemas/project.schema.json`
- Create: `schemas/plan.schema.json`
- Create: `schemas/result.schema.json`
- Create: `schemas/progress.schema.json`
- Create: `schemas/release.schema.json`
- Create: `schemas/manifest.schema.json`
- Create: `schemas/latest.schema.json`
- Create: `schemas/coverage.schema.json`
- Create: `schemas/lock.schema.json`
- Create: `src/cli/commands/schemaShow.ts`
- Create: `tests/cli/schemaShow.test.ts`
- Modify: `src/cli/run.ts` (register command; add `schema show` to capabilities `commands`)

**Interfaces:**
- Consumes: `runCli`, `okResult`, `failResult`
- Produces: `SCHEMA_KINDS` constant; `schemaShow(kind: string) → CommandResult`

```ts
export const SCHEMA_KINDS = [
  "project",
  "plan",
  "result",
  "progress",
  "release",
  "manifest",
  "latest",
  "coverage",
  "lock",
] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];
```

Unknown kind → `failResult` with `code: "validation"`, `pointer: "/kind"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("schema show", () => {
  it("returns the project schema with additionalProperties false", async () => {
    const result = await runCliJson(["schema", "show", "project", "--json"], cwd);
    expect(result.ok).toBe(true);
    const schema = result.data as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects unknown kind", async () => {
    const result = await runCliJson(["schema", "show", "nope", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/schemaShow.test.ts`

Expected: FAIL (`schema show` not registered).

- [ ] **Step 3: Write minimal implementation**

Each schema file is JSON Schema draft 2020-12. Required for `project.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://chainplot.dev/schema/project",
  "type": "object",
  "additionalProperties": false,
  "required": ["format_version", "id"],
  "properties": {
    "format_version": { "type": "integer", "const": 1 },
    "id": { "type": "string", "minLength": 1 },
    "datasets": { "type": "array", "items": { "$ref": "#/$defs/dataset" } },
    "queries": { "type": "array", "items": { "$ref": "#/$defs/query" } },
    "dashboards": { "type": "array", "items": { "$ref": "#/$defs/dashboard" } },
    "models": { "type": "array", "items": { "$ref": "#/$defs/model" } },
    "chain_sources": { "type": "array", "maxItems": 1, "items": { "$ref": "#/$defs/chain_source" } },
    "event_sources": { "type": "array", "maxItems": 20, "items": { "$ref": "#/$defs/event_source" } },
    "publish_targets": { "type": "array", "items": { "$ref": "#/$defs/publish_target" } },
    "policy": { "type": "object", "additionalProperties": false, "properties": {
      "block_budget": { "type": "integer", "minimum": 1 }
    }}
  },
  "$defs": {
    "dataset": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "snapshot"],
      "properties": {
        "id": { "type": "string" },
        "snapshot": { "type": "string" },
        "schema": { "type": "string" }
      }
    },
    "query": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "file", "dataset"],
      "properties": {
        "id": { "type": "string" },
        "file": { "type": "string" },
        "dataset": { "type": "string" },
        "raw_amount_columns": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "dashboard": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "title", "panels"],
      "properties": {
        "id": { "type": "string" },
        "title": { "type": "string" },
        "description": { "type": "string" },
        "panels": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["query", "chart"],
            "properties": {
              "query": { "type": "string" },
              "chart": { "enum": ["line", "bar", "kpi", "table"] }
            }
          }
        }
      }
    },
    "model": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "file", "depends_on"],
      "properties": {
        "id": { "type": "string" },
        "file": { "type": "string" },
        "depends_on": { "type": "array", "items": { "type": "string" } }
      }
    },
    "chain_source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "chain_id", "rpc_secret", "finality"],
      "properties": {
        "id": { "type": "string" },
        "chain_id": { "type": "integer" },
        "rpc_secret": { "type": "string" },
        "finality": {
          "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["policy"],
              "properties": { "policy": { "const": "finalized" } } },
            { "type": "object", "additionalProperties": false, "required": ["policy", "depth"],
              "properties": { "policy": { "const": "confirmation_depth" }, "depth": { "type": "integer", "minimum": 1 } } }
          ]
        }
      }
    },
    "event_source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "chain", "addresses", "abi", "events", "start_block", "end"],
      "properties": {
        "id": { "type": "string" },
        "chain": { "type": "string" },
        "addresses": { "type": "array", "minItems": 1, "maxItems": 20, "items": { "type": "string" } },
        "abi": { "type": "string" },
        "events": { "type": "array", "items": { "type": "string" } },
        "start_block": { "type": "integer", "minimum": 0 },
        "end": {
          "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["mode", "block"],
              "properties": { "mode": { "const": "pinned" }, "block": { "type": "integer" } } },
            { "type": "object", "additionalProperties": false, "required": ["mode"],
              "properties": { "mode": { "const": "follow_finalized" } } }
          ]
        }
      }
    },
    "publish_target": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "type"],
      "properties": {
        "id": { "type": "string" },
        "type": { "enum": ["directory", "s3"] },
        "path": { "type": "string" },
        "bucket": { "type": "string" }
      }
    }
  }
}
```

`result.schema.json` matches `CommandResult`. `progress.schema.json`: `{ schema_version, type: "progress", run_id, stage, message }` plus optional numeric fields. Stub the rest as objects with `schema_version` integer, `additionalProperties` true only where the spec has not yet frozen fields (`plan`, `coverage`); `latest` requires `prefix` and `release_json_checksum` strings; `lock` requires `format_version` integer; `manifest` requires `snapshot_id` string and `mode` enum `results_only` | `dataset_included` | `dataset_referenced`; `release` requires `schema_version`, `project_id`, `mode`.

`schemaShow` reads `schemas/<kind>.schema.json` from the package root (resolve via `import.meta.url` relative to `src/`, then `../../schemas`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/schemaShow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schemas src/cli tests/cli/schemaShow.test.ts
git commit -m "feat: add JSON Schema kinds and schema show"
```

---

### Task 3: Load and validate `chainplot.yaml`

**Files:**
- Create: `src/project/types.ts`
- Create: `src/project/load.ts`
- Create: `src/project/validate.ts`
- Create: `src/cli/commands/validate.ts`
- Create: `tests/cli/validate.test.ts`
- Create: `tests/fixtures/projects/valid-dataset-only/chainplot.yaml`
- Create: `tests/fixtures/projects/unknown-field/chainplot.yaml`
- Create: `tests/fixtures/projects/follow-plus-depth/chainplot.yaml`
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: project JSON Schema from Task 2
- Produces:

```ts
export function loadProject(projectDir: string): unknown;
export function validateProject(doc: unknown, projectDir: string): {
  ok: true;
  project: ProjectDocument;
} | {
  ok: false;
  error: CommandError;
};
```

`ProjectDocument` fields match the schema `$defs` names: `format_version`, `id`, `datasets`, `queries`, `dashboards`, optional `models`, `chain_sources`, `event_sources`, `publish_targets`, `policy`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/projects",
);

describe("validate", () => {
  it("accepts a dataset-only project", async () => {
    const result = await runCliJson(["validate", "--json"], path.join(fixtures, "valid-dataset-only"));
    expect(result.ok).toBe(true);
    expect(result.command).toBe("validate");
  });

  it("rejects unknown fields", async () => {
    const result = await runCliJson(["validate", "--json"], path.join(fixtures, "unknown-field"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("rejects follow_finalized plus confirmation_depth", async () => {
    const result = await runCliJson(["validate", "--json"], path.join(fixtures, "follow-plus-depth"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unsupported_capability");
  });
});
```

`valid-dataset-only/chainplot.yaml`:

```yaml
format_version: 1
id: fixture-transfers
datasets:
  - id: amounts
    snapshot: snapshots/amounts.parquet
queries:
  - id: raw_amounts
    file: queries/raw_amounts.sql
    dataset: amounts
    raw_amount_columns: [amount]
dashboards:
  - id: overview
    title: Amounts
    panels:
      - query: raw_amounts
        chart: table
```

`unknown-field/chainplot.yaml`: same plus `extra: true`.

`follow-plus-depth/chainplot.yaml`: one `chain_sources` entry with `finality.policy: confirmation_depth` and `depth: 12`, one `event_sources` entry with `end.mode: follow_finalized`, plus dummy datasets/queries so the rest of the schema passes.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/validate.test.ts`

Expected: FAIL (`validate` not registered).

- [ ] **Step 3: Write minimal implementation**

`load.ts`: read `path.join(projectDir, "chainplot.yaml")` with `fs.readFileSync` + `yaml.parse`. Missing file → throw a `CommandError` with `validation`.

`validate.ts`: compile `project.schema.json` with Ajv `{ allErrors: true, strict: true }`. Map Ajv `additionalProperties` errors to `pointer` JSON Pointer. After schema pass: if any `event_sources[].end.mode === "follow_finalized"` and the referenced chain `finality.policy === "confirmation_depth"`, return `unsupported_capability`. If `format_version !== 1`, `unsupported_capability`. Resolve query `file` and dataset `snapshot` paths relative to `projectDir`; missing files → `validation` with `resource_id` set to the query/dataset id.

`validate` command: `loadProject(opts.cwd)` then `validateProject`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/validate.test.ts`

Expected: PASS. (Missing parquet is OK if validate only checks the YAML path exists — create empty placeholder files `snapshots/.keep` in the valid fixture, or skip snapshot existence until Task 5. **This task: YAML + schema + policy combo only.** Do not require parquet yet. Document that in `validate.ts`: snapshot-file existence is Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/project src/cli/commands/validate.ts tests/cli/validate.test.ts tests/fixtures
git commit -m "feat: validate chainplot.yaml against JSON Schema"
```

---

### Task 4: `templates list` and `init`

**Files:**
- Create: `templates/fixture-transfers/chainplot.yaml`
- Create: `templates/fixture-transfers/queries/raw_amounts.sql`
- Create: `templates/fixture-transfers/dashboards/overview.yaml` (optional; panels may live in `chainplot.yaml` only — keep panels in `chainplot.yaml` to avoid two sources of truth)
- Create: `templates/fixture-transfers/tests/amounts.yaml`
- Create: `src/cli/commands/templates.ts`
- Create: `src/cli/commands/init.ts`
- Create: `tests/cli/init.test.ts`
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: `loadProject` / `validateProject` from Task 3
- Produces: `listTemplates() → { id, required_inputs, limitations }[]`; `initTemplate(id, outputDir)`

Template id: `fixture-transfers`.

Limitations string: `dataset-only fixture; no RPC; no ingest`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliJson } from "../helpers/run.js";

describe("init", () => {
  it("lists fixture-transfers", async () => {
    const result = await runCliJson(["templates", "list", "--json"], process.cwd());
    expect(result.ok).toBe(true);
    const ids = (result.data as { templates: { id: string }[] }).templates.map((t) => t.id);
    expect(ids).toContain("fixture-transfers");
  });

  it("creates a project and fails on collision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-init-"));
    const first = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", dir, "--json"],
      process.cwd(),
    );
    expect(first.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "chainplot.yaml"))).toBe(true);
    const second = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", dir, "--json"],
      process.cwd(),
    );
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("validation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/init.test.ts`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Copy files from `templates/fixture-transfers/` into `--output` with `fs.cpSync(..., { recursive: true, errorOnExist: true, force: false })`. If the output directory exists and is non-empty **or** any destination file exists, fail `validation` (`message` names the colliding path). After copy, the parquet may still be missing until Task 5 — include `snapshots/` in the template only after Task 5 generates it. For this task, copy yaml + sql + tests.

`chainplot.yaml` in the template matches Task 3 valid fixture.

`queries/raw_amounts.sql`:

```sql
SELECT amount
FROM amounts
ORDER BY amount_sort
```

(`amount_sort` column lands in Task 5 parquet. For this task the SQL file only needs to exist.)

Unknown `--template` → `validation`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/init.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add templates src/cli/commands/templates.ts src/cli/commands/init.ts tests/cli/init.test.ts src/cli/run.ts
git commit -m "feat: add templates list and init"
```

---

### Task 5: Fixture Parquet, `dataset describe`, snapshot existence

**Files:**
- Create: `src/snapshot/describe.ts`
- Create: `src/cli/commands/describe.ts`
- Create: `scripts/write-fixture-parquet.ts`
- Create: `templates/fixture-transfers/snapshots/amounts.parquet` (generated, committed)
- Create: `tests/cli/describe.test.ts`
- Modify: `src/project/validate.ts` (require snapshot files to exist)
- Modify: `tests/cli/validate.test.ts` (valid fixture must include parquet or point at the template)

**Interfaces:**
- Consumes: `validateProject`
- Produces:

```ts
export interface DatasetDescribeData {
  id: string;
  mode: "dataset_included";
  snapshot: string;
  columns: { name: string; logical_type: string }[];
  coverage: null;
}

export function describeDataset(
  projectDir: string,
  datasetId: string,
): Promise<DatasetDescribeData>;
```

M1 fixture mode is always `dataset_included` (files on disk). `coverage` is `null` (no ingest).

Parquet columns (exact):

| name | physical | logical |
|---|---|---|
| amount | VARCHAR | decimal-string int256 |
| amount_sort | VARCHAR | zero-padded sign-aware sort key, width 78 + 1 sign |

Rows (exact amount strings): `0`, `1`, `-1`, `9007199254740993` (2^53+1), `-9007199254740993`, `57896044618658097711785492504343953926634992332820282019728792003956564819967` (2^255-1), `-57896044618658097711785492504343953926634992332820282019728792003956564819968` (-2^255), `115792089237316195423570985008687907853269984665640564039457584007913129639935` (2^256-1).

Sort key: `'0'` + 78-digit zero-padded absolute value for non-negative; `'1'` + 78-digit zero-padded `(10^78 - abs)` for negative (standard decimal two's-complement style so `ORDER BY amount_sort` is numeric). Document the formula in `scripts/write-fixture-parquet.ts` comments.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("dataset describe", () => {
  it("describes the fixture snapshot", async () => {
    const result = await runCliJson(
      ["dataset", "describe", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      id: "amounts",
      mode: "dataset_included",
    });
    const cols = (result.data as { columns: { name: string }[] }).columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["amount", "amount_sort"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/describe.test.ts`

Expected: FAIL (no parquet / command).

- [ ] **Step 3: Write minimal implementation**

`scripts/write-fixture-parquet.ts` uses `@duckdb/node-api`: `CREATE TABLE amounts (amount VARCHAR, amount_sort VARCHAR)`, insert the eight rows, `COPY amounts TO 'templates/fixture-transfers/snapshots/amounts.parquet' (FORMAT PARQUET)`. Run: `pnpm exec tsx scripts/write-fixture-parquet.ts` (add `tsx` as a devDependency if `pnpm exec tsx` is missing).

`describe.ts`: open parquet with DuckDB in-process **only in this command's parent** is not allowed — use the worker from Task 6. For Task 5, read parquet metadata via a one-shot worker helper `describeParquet(path)` that will move into `src/query/runQuery.ts` in Task 6. To keep this task shippable without the worker yet, spawn the same child module path Task 6 will use: if `workerMain.ts` does not exist, implement a minimal `src/query/inspectParquet.ts` that creates an in-process connection, runs `DESCRIBE SELECT * FROM read_parquet(?)`, returns column names, then closes. Task 6 replaces in-process inspect with the worker; **do not leave in-process query execution after Task 6.**

Unknown dataset id → `validation`, `resource_id` = the id.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/describe.test.ts tests/cli/validate.test.ts`

Expected: PASS. Commit the generated parquet (binary is required; it is the fixture).

- [ ] **Step 5: Commit**

```bash
git add templates/fixture-transfers/snapshots src/snapshot src/cli/commands/describe.ts scripts tests/cli/describe.test.ts src/project/validate.ts
git commit -m "feat: add fixture parquet and dataset describe"
```

---

### Task 6: DuckDB child worker, `query`, A8 strings and sort key

**Files:**
- Create: `src/query/workerMain.ts`
- Create: `src/query/runQuery.ts`
- Create: `src/query/forbidOrderByRaw.ts`
- Create: `src/cli/commands/query.ts`
- Create: `tests/cli/query.test.ts`
- Modify: `src/snapshot/describe.ts` (call worker, remove in-process DuckDB if introduced in Task 5)
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: dataset snapshot path from `ProjectDocument`
- Produces:

```ts
export interface QueryRequest {
  sql: string;
  tables: Record<string, string>;
  analysisTimestamp: string;
  rawAmountColumns: string[];
  rowLimit: number;
}

export interface QuerySuccess {
  columns: { name: string; logical_type: string }[];
  rows: unknown[][];
  snapshot: string;
}

export function runQuery(req: QueryRequest): Promise<QuerySuccess>;
```

Worker protocol (stdin/stdout JSON lines, one request, one response, then exit):

Parent writes: `JSON.stringify({ sql, tables, analysisTimestamp }) + "\n"`.
Child prints: `JSON.stringify({ ok: true, columns, rows })` or `{ ok: false, message }` using `getRowsJson()`.
`tables` maps SQL table name → parquet path. Child `CREATE VIEW <name> AS SELECT * FROM read_parquet(path)` for each. No `INSTALL` / `LOAD` of httpfs or postgres. Child starts with `env` stripped to `PATH`, `HOME`, `LANG` only.

Limits: `rowLimit` default `10000`. More rows → `policy_refused`. Deadline 60s: parent `timeout` kills the child, `transient_dependency`.

`forbidOrderByRaw(sql, rawAmountColumns)`: if a raw amount column appears as an `ORDER BY` expression (token match on column name after `ORDER BY`), throw `validation`. Do not parse a full SQL grammar; split on `ORDER BY` (case-insensitive) and reject if any raw column name appears in that tail.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("query", () => {
  it("returns 2^256-1 as a decimal string, not a number", async () => {
    const sql = path.join(os.tmpdir(), "q-a8.sql");
    fs.writeFileSync(sql, "SELECT amount FROM amounts ORDER BY amount_sort");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(true);
    const rows = (result.data as { rows: string[][] }).rows;
    const amounts = rows.map((r) => r[0]);
    expect(typeof amounts[0]).toBe("string");
    expect(amounts).toContain(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
    expect(amounts[0]).toBe(
      "-57896044618658097711785492504343953926634992332820282019728792003956564819968",
    );
  });

  it("rejects ORDER BY on a raw amount column", async () => {
    const sql = path.join(os.tmpdir(), "q-bad.sql");
    fs.writeFileSync(sql, "SELECT amount FROM amounts ORDER BY amount");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/query.test.ts`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

`workerMain.ts`: read one JSON line from stdin, open in-memory DuckDB, create views, `runAndReadAll`, `getRowsJson()`, write one JSON object, exit. Catch errors into `{ ok: false, message }`.

`runQuery.ts`: `fork(workerPath, { env: { PATH, HOME, LANG } })`. `workerPath` is `new URL("./workerMain.js", import.meta.url)` after compile; in vitest use `tsx` by setting `execArgv: ["--import", "tsx"]` if running TS, or point vitest `vite-node` at the TS file via `fork(fileURLToPath(new URL("./workerMain.ts", import.meta.url)), { execArgv: ["--import", "tsx"] })`. Pick one and keep it for all tests.

`query` command: `--file` required, `--snapshot` is the dataset id. Load project from `cwd`. Resolve parquet. `analysisTimestamp` = snapshot file mtime as UTC ISO (M1 has no ingest analysis time).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/query.test.ts`

Expected: PASS. Confirm the huge integer is a string in the parsed JSON (`typeof === "string"`).

- [ ] **Step 5: Commit**

```bash
git add src/query src/cli/commands/query.ts tests/cli/query.test.ts src/snapshot
git commit -m "feat: query snapshots in a DuckDB child process"
```

---

### Task 7: `test` assertions

**Files:**
- Create: `src/project/assertions.ts`
- Create: `src/cli/commands/test.ts`
- Create: `tests/cli/testCmd.test.ts`
- Modify: `templates/fixture-transfers/tests/amounts.yaml`
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: `runQuery`, `validateProject`
- Produces:

```ts
export interface AssertionFile {
  dataset: string;
  query?: string;
  expect: {
    row_count?: number;
    columns?: string[];
  };
}

export function runAssertions(projectDir: string): Promise<CommandResult>;
```

Assertion YAML (`tests/*.yaml`): `additionalProperties: false`. M1 supports `row_count` and `columns` only.

Fixture `tests/amounts.yaml`:

```yaml
dataset: amounts
expect:
  row_count: 8
  columns: [amount, amount_sort]
```

Missing local data → `validation` (do not fetch). `test` command network: none.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("test", () => {
  it("passes fixture assertions", async () => {
    const result = await runCliJson(["test", "--json"], template);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/testCmd.test.ts`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Glob `tests/*.yaml` under `projectDir`. For each file, load YAML, require `dataset`, `SELECT * FROM <dataset>` via `runQuery` with `rawAmountColumns: []` and `ORDER BY` omitted (use `SELECT * FROM t` without ORDER BY). Compare `rows.length` to `row_count` and column names. First failure: `ok: false`, `code: validation`, `resource_id` = dataset id, `pointer` = the assertion file path as a string.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/testCmd.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/project/assertions.ts src/cli/commands/test.ts tests/cli/testCmd.test.ts templates/fixture-transfers/tests
git commit -m "feat: add chainplot test assertions"
```

---

### Task 8: M1 `build` (results + manifests, no HTML)

**Files:**
- Create: `src/cli/commands/build.ts`
- Create: `src/publish/writeRelease.ts`
- Create: `tests/cli/build.test.ts`
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: `validateProject`, `runQuery`
- Produces:

```ts
export function buildRelease(projectDir: string): Promise<{
  distDir: string;
  files: string[];
}>;
```

Output layout (M1):

```text
dist/releases/local/
  release.json
  results/<query-id>.json
  datasets/<dataset-id>/manifest.json
```

`release.json`: `{ schema_version: 1, project_id, mode: "dataset_included", queries: [<query ids>] }`.
`manifest.json`: `{ snapshot_id: <dataset id>, mode: "dataset_included", files: ["tables/amounts.parquet"] }` — M1 does **not** copy parquet into dist (results-only would be wrong; included means the project already has the snapshot locally). Set `mode` to `dataset_included` and `files` relative to the project snapshot path recorded as `source_path`. Do not write `index.html`.

Each `results/<query-id>.json`: `{ schema_version: 1, query_id, columns, rows, snapshot }` from `runQuery` on the query SQL file. Use `getRowsJson` strings.

If any query fails, `build` fails; do not write a partial `release.json` (write to a temp dir then rename).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("build", () => {
  it("writes release.json and query results without HTML", async () => {
    const result = await runCliJson(["build", "--json"], template);
    expect(result.ok).toBe(true);
    const dist = path.join(template, "dist/releases/local");
    expect(fs.existsSync(path.join(dist, "release.json"))).toBe(true);
    expect(fs.existsSync(path.join(dist, "index.html"))).toBe(false);
    const raw = JSON.parse(
      fs.readFileSync(path.join(dist, "results/raw_amounts.json"), "utf8"),
    );
    expect(typeof raw.rows[0][0]).toBe("string");
  });
});
```

Add `dist/` under `templates/` to `.gitignore` if tests write there, **or** write to a copied temp project in the test. Prefer copy the template to `mkdtemp` so the git tree stays clean.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/build.test.ts`

Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

`build.ts`: validate, for each query `runQuery`, write staging dir `dist/releases/local/.tmp-*`, then `fs.renameSync` onto `dist/releases/local`. Command data: `{ distDir, files }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/cli/build.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/build.ts src/publish tests/cli/build.test.ts .gitignore
git commit -m "feat: build cached query results for fixture projects"
```

---

### Task 9: A15 network-disabled e2e and README command list

**Files:**
- Create: `tests/cli/a15.e2e.test.ts`
- Modify: `README.md`
- Modify: `src/cli/commands/capabilities.ts` (commands list = all M1 commands)

**Interfaces:**
- Consumes: all M1 commands
- Produces: documented agent path; A15 green

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("A15", () => {
  it("init, validate, test, build with network disabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-a15-"));
    const env = {
      ...process.env,
      NO_NETWORK: "1",
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    const bin = path.resolve("src/cli/main.ts");
    const run = (args: string[], cwd: string) =>
      spawnSync("pnpm", ["exec", "tsx", bin, ...args, "--json"], {
        cwd,
        env,
        encoding: "utf8",
      });
    const init = run(
      ["init", "--template", "fixture-transfers", "--output", dir],
      process.cwd(),
    );
    expect(init.status).toBe(0);
    for (const cmd of [["validate"], ["test"], ["build"]]) {
      const r = run(cmd, dir);
      expect(r.status, r.stderr).toBe(0);
      const json = JSON.parse(r.stdout);
      expect(json.ok).toBe(true);
      expect(json.schema_version).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/cli/a15.e2e.test.ts`

Expected: FAIL until spawn + tsx path is wired; fix the bin invocation to match Task 6 (`pnpm exec tsx src/cli/main.ts`).

- [ ] **Step 3: Write minimal implementation**

No new features. Fix spawn if `runCli` vs process entry disagrees. Update `capabilities.commands` to:

`["capabilities", "schema show", "templates list", "init", "validate", "dataset describe", "query", "test", "build"]`

README: replace "design only" with the M1 command list and:

```text
pnpm install
pnpm exec tsx src/cli/main.ts init --template fixture-transfers --output ./demo --json
cd demo
pnpm exec tsx ../src/cli/main.ts validate --json
pnpm exec tsx ../src/cli/main.ts test --json
pnpm exec tsx ../src/cli/main.ts build --json
```

Use repo-relative commands. Do not mention machine-specific paths.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`

Expected: all tests PASS, including A15.

- [ ] **Step 5: Commit**

```bash
git add tests/cli/a15.e2e.test.ts README.md src/cli/commands/capabilities.ts
git commit -m "test: A15 fixture quickstart with network disabled"
```

---

## Self-review

**Spec coverage (M1 only):**
- Agent `--json` envelope, integer `schema_version`, closed error codes: Task 1
- JSON Schema kinds + `schema show`: Task 2
- Unknown fields, format_version, `follow_finalized`+`confirmation_depth`: Task 3
- `init` / `templates list`: Task 4
- Dataset describe, fixture snapshot: Task 5
- DuckDB child, uint256 strings, ORDER BY raw forbidden, A8 values: Task 6
- `test` no-fetch assertions: Task 7
- M1 `build` without HTML: Task 8
- A15: Task 9
- Not in this plan (M2+): rindexer, coverage completeness, plan/apply ingest, refresh ingest, doctor, publish, fork, serve, S3, Compose, viewer, A1–A4, A6, A7, A9–A14, A16

**Placeholders:** none. Versions pinned via pnpm lock in Task 1; DuckDB neo pin recorded in `docs/compatibility.md`.

**Type consistency:** `runCli` / `CommandResult` / `ErrorCode` / `ProjectDocument` / `runQuery` / `QueryRequest` names are stable across tasks.
