import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SerializedSql, SqlIssue } from "./sqlGuard.js";

// This module is forked as a bare node process, so it is loaded as .ts under
// vitest and as .js from dist/. Node's type stripping does not rewrite `.js`
// specifiers back to `.ts`, so the sibling import is resolved at runtime.
// The type-only import above is erased and needs no such treatment.
const { inspectSerializedSql } = (await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./sqlGuard.ts" : "./sqlGuard.js",
    import.meta.url,
  ).href
)) as typeof import("./sqlGuard.js");

interface WorkerRequest {
  sql: string;
  tables: Record<string, string>;
  rawAmountColumns?: string[];
  rowLimit?: number;
  models?: { id: string; sql: string }[];
}

const MODEL_ID = /^[a-z0-9_]+$/;
// Fallback only: every caller passes an explicit limit. This module is
// forked as a bare process and deliberately imports no project code.
const DEFAULT_ROW_LIMIT = 10_000;

// A forked recipe runs here, so an unbounded query is the host's problem.
// DuckDB spills past this rather than failing, provided a temp directory
// exists — without one it raises an out-of-memory error instead.
const MEMORY_LIMIT = process.env.CHAINPLOT_QUERY_MEMORY_LIMIT ?? "1GB";

/**
 * Canonical sort key for uint256/int256 amounts carried as decimal strings.
 *
 * One sign digit then a fixed 78-digit body, so plain lexicographic order is
 * signed-numeric order:
 *   negative     → '0' + nines-complement of the zero-padded magnitude
 *   non-negative → '1' + zero-padded magnitude
 *
 * Nines-complement (not tens) keeps this pure string work: DuckDB's widest
 * integer is 128-bit, so 10^78 arithmetic is not available. Complementing the
 * magnitude reverses its order, which is exactly what negative numbers need
 * (-10 must sort before -9), and the leading sign digit puts every negative
 * ahead of every non-negative.
 */
const SORT_KEY_MACRO = `
CREATE MACRO cp_sortkey(v) AS (
  CASE
    WHEN v IS NULL THEN NULL
    WHEN starts_with(CAST(v AS VARCHAR), '-')
      THEN '0' || translate(
             lpad(substr(CAST(v AS VARCHAR), 2), 78, '0'),
             '0123456789', '9876543210')
    ELSE '1' || lpad(CAST(v AS VARCHAR), 78, '0')
  END
)`;

function issueError(issue: SqlIssue): Error {
  const err = new Error(issue.message) as Error & { chainplotCode?: string };
  err.chainplotCode = issue.code;
  return err;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface Conn {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRowsJson(): unknown[][] }>;
  streamAndReadUntil(
    sql: string,
    rows: number,
  ): Promise<{
    columnCount: number;
    columnName(i: number): string;
    columnType(i: number): { toString(): string };
    currentRowCount: number;
    done: boolean;
    getRowsJson(): unknown[][];
  }>;
}

/**
 * Parse `sql` with DuckDB and apply admission control. Throws on refusal.
 *
 * `json_serialize_sql` only accepts a literal, so the statement is inlined as
 * a quoted string; it is parsed, never executed, by this call.
 */
async function assertAdmissible(
  conn: Conn,
  sql: string,
  opts: { label: string; rawAmountColumns?: string[] },
): Promise<void> {
  let serialized: SerializedSql;
  try {
    const reader = await conn.runAndReadAll(
      `SELECT json_serialize_sql(${quoteString(sql)})`,
    );
    serialized = JSON.parse(String(reader.getRowsJson()[0]?.[0] ?? "{}")) as SerializedSql;
  } catch (err) {
    throw issueError({
      code: "validation",
      message: `${opts.label} failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const issue = inspectSerializedSql(serialized, opts);
  if (issue) throw issueError(issue);
}

async function readRequest(): Promise<WorkerRequest> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      return JSON.parse(buf.slice(0, nl)) as WorkerRequest;
    }
  }
  if (!buf) {
    throw new Error("empty worker request");
  }
  return JSON.parse(buf) as WorkerRequest;
}

async function execute(req: WorkerRequest): Promise<{
  columns: { name: string; logical_type: string }[];
  rows: unknown[][];
  truncated: boolean;
}> {
  const rowLimit = req.rowLimit ?? DEFAULT_ROW_LIMIT;
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-duckdb-"));
  const instance = await DuckDBInstance.create(":memory:", {
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    memory_limit: MEMORY_LIMIT,
    temp_directory: spillDir,
  });
  try {
    const conn = (await instance.connect()) as unknown as Conn;
    try {
      // Snapshots are the only filesystem reads this process is allowed to
      // make, so they happen first...
      for (const [name, parquetPath] of Object.entries(req.tables)) {
        await conn.run(
          `CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM read_parquet(${quoteString(parquetPath)})`,
        );
      }

      // ...and the door is shut before any project-supplied SQL runs. Models
      // arrive from `source/models/` of a forked release and are no more
      // trusted than the query itself, so they must land on this side of it.
      // DuckDB does not allow re-enabling external access in a session.
      await conn.run("SET enable_external_access=false");
      await conn.run(SORT_KEY_MACRO);

      for (const model of req.models ?? []) {
        if (!MODEL_ID.test(model.id)) {
          throw issueError({
            code: "validation",
            message: `invalid model id: ${model.id}`,
          });
        }
        await assertAdmissible(conn, model.sql, { label: `model ${model.id}` });
        try {
          await conn.run(`CREATE TABLE ${quoteIdent(model.id)} AS (${model.sql})`);
        } catch (err) {
          throw issueError({
            code: "validation",
            message: `model ${model.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      await assertAdmissible(conn, req.sql, {
        label: "query",
        rawAmountColumns: req.rawAmountColumns ?? [],
      });

      // Stop reading at the limit instead of materializing everything and
      // rejecting afterwards; `done` tells us whether more rows existed.
      const reader = await conn.streamAndReadUntil(req.sql, rowLimit + 1);
      const columns: { name: string; logical_type: string }[] = [];
      for (let i = 0; i < reader.columnCount; i++) {
        columns.push({
          name: reader.columnName(i),
          logical_type: reader.columnType(i).toString(),
        });
      }
      const all = reader.getRowsJson();
      const truncated = all.length > rowLimit || !reader.done;
      return { columns, rows: all.slice(0, rowLimit), truncated };
    } finally {
      (conn as unknown as { closeSync(): void }).closeSync();
    }
  } finally {
    instance.closeSync();
    fs.rmSync(spillDir, { recursive: true, force: true });
  }
}

function reply(payload: unknown, exitCode: number): void {
  fs.writeSync(1, JSON.stringify(payload) + "\n");
  process.exit(exitCode);
}

try {
  const req = await readRequest();
  const { columns, rows, truncated } = await execute(req);
  reply({ ok: true, columns, rows, truncated }, 0);
} catch (err) {
  const code =
    err !== null && typeof err === "object" && "chainplotCode" in err
      ? String((err as { chainplotCode: unknown }).chainplotCode)
      : "validation";
  const message = err instanceof Error ? err.message : String(err);
  reply({ ok: false, code, message }, 1);
}
