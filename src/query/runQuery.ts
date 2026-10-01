import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CommandError } from "../cli/envelope.js";

export interface QueryRequest {
  sql: string;
  tables: Record<string, string>;
  rawAmountColumns: string[];
  rowLimit: number;
  models?: { id: string; sql: string }[];
}

export interface QuerySuccess {
  columns: { name: string; logical_type: string }[];
  rows: unknown[][];
  snapshot: string;
}

export interface ParquetColumn {
  name: string;
  logical_type: string;
}

export interface BatchQuery {
  id: string;
  sql: string;
  rawAmountColumns: string[];
  rowLimit: number;
}

export interface BatchRequest {
  tables: Record<string, string>;
  models?: { id: string; sql: string }[];
  queries: BatchQuery[];
}

export interface BatchResult {
  id: string;
  columns: { name: string; logical_type: string }[];
  rows: unknown[][];
}

// Per step, not per batch: loading the snapshots and building the models get
// one deadline, and each query gets its own after that. A batch of nineteen
// queries is therefore held to what nineteen separate workers were.
const DEADLINE_MS = 60_000;

function error(
  code: CommandError["code"],
  message: string,
  opts: { retryable?: boolean; resource_id?: string | null } = {},
): CommandError {
  return {
    code,
    message,
    resource_id: opts.resource_id ?? null,
    pointer: null,
    retryable: opts.retryable ?? false,
    suggested_next: null,
  };
}

function workerLaunch(): { modulePath: string; execArgv: string[] } {
  const self = fileURLToPath(import.meta.url);
  const isTs = self.endsWith(".ts");
  const modulePath = fileURLToPath(
    new URL(isTs ? "./workerMain.ts" : "./workerMain.js", import.meta.url),
  );
  const execArgv =
    isTs && !process.features.typescript ? ["--experimental-strip-types"] : [];
  return { modulePath, execArgv };
}

function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG"] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** One line the worker wrote: setup done, a query's rows, or a failure. */
type WorkerLine =
  | { ready: true }
  | { ok: true; id: string; columns: BatchResult["columns"]; rows: unknown[][]; truncated: boolean }
  | { ok: false; code?: string; message?: string; model?: string; query?: string };

const named = (id: string): string => (id ? `query ${id}` : "query");

function parseLine(line: string): WorkerLine | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" ? (parsed as WorkerLine) : null;
  } catch {
    return null;
  }
}

/**
 * Run a batch of queries in one isolated worker: snapshots load and models
 * build once, then each query runs in turn. Resolves with every result in
 * order, or rejects with the first failure, naming the model or query that
 * caused it.
 */
export function runQueries(
  req: BatchRequest,
  opts: { deadlineMs?: number } = {},
): Promise<BatchResult[]> {
  if (req.queries.length === 0) return Promise.resolve([]);
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const { modulePath, execArgv } = workerLaunch();
  return new Promise((resolve, reject) => {
    const child = fork(modulePath, [], {
      execArgv,
      env: strippedEnv(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const results: BatchResult[] = [];
    let buffered = "";
    let stderr = "";
    let ready = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    // What the worker is doing right now, for the deadline's message. A single
    // query from runQuery has an empty id, and is simply "query".
    const waitingOn = (): string | null =>
      ready ? (req.queries[results.length]?.id ?? null) : null;

    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        const id = waitingOn();
        finish(
          error(
            "transient_dependency",
            id === null
              ? `loading snapshots and building models took longer than ${deadlineMs / 1000} s`
              : `${named(id)} took longer than ${deadlineMs / 1000} s`,
            { retryable: true, resource_id: id || null },
          ),
        );
      }, deadlineMs);
    };

    function finish(err: CommandError | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill("SIGKILL");
        reject(err);
      } else {
        resolve(results);
      }
    }

    function handle(line: WorkerLine): void {
      if ("ready" in line) {
        ready = true;
        arm();
        return;
      }
      if (line.ok === true) {
        const query = req.queries[results.length];
        if (line.truncated && query) {
          finish(
            error(
              "policy_refused",
              `${named(query.id)} returned more than ${query.rowLimit} rows; add a LIMIT or aggregate instead`,
              { resource_id: query.id || null },
            ),
          );
          return;
        }
        results.push({ id: line.id, columns: line.columns, rows: line.rows });
        if (results.length === req.queries.length) finish(null);
        else arm();
        return;
      }
      finish(
        error((line.code ?? "validation") as CommandError["code"], String(line.message ?? "worker failed"), {
          resource_id: line.model ?? (line.query || null),
        }),
      );
    }

    arm();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const parsed = parseLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        if (parsed) handle(parsed);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish(error("internal", err.message)));
    child.on("exit", (code) => {
      if (settled) return;
      const detail = stderr.trim() || `worker exited with code ${code ?? "unknown"}`;
      finish(error("internal", detail, { resource_id: waitingOn() || null }));
    });

    child.stdin?.write(
      JSON.stringify({ tables: req.tables, models: req.models ?? [], queries: req.queries }) + "\n",
    );
    child.stdin?.end();
  });
}

export async function runQuery(req: QueryRequest): Promise<QuerySuccess> {
  const [result] = await runQueries({
    tables: req.tables,
    models: req.models,
    queries: [{ id: "", sql: req.sql, rawAmountColumns: req.rawAmountColumns, rowLimit: req.rowLimit }],
  });
  return {
    columns: result!.columns,
    rows: result!.rows,
    snapshot: Object.values(req.tables)[0] ?? "",
  };
}

export async function describeParquet(parquetPath: string): Promise<ParquetColumn[]> {
  const { rows } = await runQuery({
    sql: "DESCRIBE SELECT * FROM snapshot",
    tables: { snapshot: parquetPath },
    rawAmountColumns: [],
    rowLimit: 10_000,
  });
  return rows.map((row) => ({
    name: String(row[0]),
    logical_type: String(row[1]),
  }));
}
