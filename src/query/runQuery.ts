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

const DEADLINE_MS = 60_000;

function error(
  code: CommandError["code"],
  message: string,
  opts: { retryable?: boolean } = {},
): CommandError {
  return {
    code,
    message,
    resource_id: null,
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

interface WorkerSuccess {
  columns: { name: string; logical_type: string }[];
  rows: unknown[][];
  truncated: boolean;
}

function parseWorkerPayload(
  line: string,
):
  | { ok: true; value: WorkerSuccess }
  | { ok: false; code: CommandError["code"]; message: string }
  | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("ok" in parsed)) {
    return null;
  }
  const body = parsed as {
    ok: unknown;
    columns?: WorkerSuccess["columns"];
    rows?: WorkerSuccess["rows"];
    truncated?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (body.ok === true && body.columns !== undefined && body.rows !== undefined) {
    return {
      ok: true,
      value: {
        columns: body.columns,
        rows: body.rows,
        truncated: body.truncated === true,
      },
    };
  }
  if (body.ok === false) {
    const code = typeof body.code === "string" ? body.code : "validation";
    return {
      ok: false,
      code: code as CommandError["code"],
      message: String(body.message ?? "worker failed"),
    };
  }
  return null;
}

function invokeWorker(req: {
  sql: string;
  tables: Record<string, string>;
  rawAmountColumns?: string[];
  rowLimit?: number;
  models?: { id: string; sql: string }[];
}): Promise<WorkerSuccess> {
  const { modulePath, execArgv } = workerLaunch();
  return new Promise((resolve, reject) => {
    const child = fork(modulePath, [], {
      execArgv,
      env: strippedEnv(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        error("transient_dependency", "query deadline exceeded", {
          retryable: true,
        }),
      );
    }, DEADLINE_MS);

    function finish(err: CommandError | null, value?: WorkerSuccess): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(value as WorkerSuccess);
      }
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish(error("internal", err.message));
    });
    child.on("exit", (code) => {
      const payload = parseWorkerPayload(stdout.trim().split("\n").pop() ?? "");
      if (payload?.ok === true) {
        finish(null, payload.value);
        return;
      }
      if (payload?.ok === false) {
        finish(error(payload.code, payload.message));
        return;
      }
      const detail = stderr.trim() || `worker exited with code ${code ?? "unknown"}`;
      finish(error("internal", detail));
    });

    child.stdin?.write(
      JSON.stringify({
        sql: req.sql,
        tables: req.tables,
        rawAmountColumns: req.rawAmountColumns ?? [],
        rowLimit: req.rowLimit,
        models: req.models ?? [],
      }) + "\n",
    );
    child.stdin?.end();
  });
}

export async function runQuery(req: QueryRequest): Promise<QuerySuccess> {
  const { columns, rows, truncated } = await invokeWorker(req);
  if (truncated) {
    throw error(
      "policy_refused",
      `query returned more than ${req.rowLimit} rows; add a LIMIT or aggregate instead`,
    );
  }
  return {
    columns,
    rows,
    snapshot: Object.values(req.tables)[0] ?? "",
  };
}

export async function describeParquet(parquetPath: string): Promise<ParquetColumn[]> {
  const { rows } = await invokeWorker({
    sql: "DESCRIBE SELECT * FROM snapshot",
    tables: { snapshot: parquetPath },
  });
  return rows.map((row) => ({
    name: String(row[0]),
    logical_type: String(row[1]),
  }));
}
