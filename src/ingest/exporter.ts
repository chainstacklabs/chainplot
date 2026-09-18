import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventTableName } from "./rindexer/inspectCoverage.js";
import type { BoundedJob } from "./adapter.js";

export interface ExportRequest {
  databaseUrl: string;
  networkName: string;
  contractName: string;
  event: string;
  chainId: number;
  outPath: string;
}

function escapeSingleQuotes(text: string): string {
  return text.replaceAll("'", "''");
}

export function buildExportSql(req: ExportRequest): string {
  const table = eventTableName(req.networkName, req.contractName, req.event);
  return [
    "INSTALL postgres;",
    "LOAD postgres;",
    `ATTACH '${escapeSingleQuotes(req.databaseUrl)}' AS pg (TYPE POSTGRES, READ_ONLY);`,
    `SELECT count(*)::bigint AS total, count(DISTINCT (contract_address, block_number, tx_hash, log_index))::bigint AS distinct_keys FROM pg.${table};`,
    `COPY (SELECT * REPLACE (CAST(block_number AS BIGINT) AS block_number, CAST(tx_index AS BIGINT) AS tx_index), ${req.chainId} AS chain_id FROM pg.${table}) TO '${escapeSingleQuotes(req.outPath)}' (FORMAT PARQUET);`,
    `SELECT count(*)::bigint AS n FROM read_parquet('${escapeSingleQuotes(req.outPath)}');`,
  ].join("\n");
}

/** The shape `runAndReadAll` gives back; only the part we read from. */
interface RowReader {
  getRowObjectsJson(): unknown[];
}

export interface UniquenessCounts {
  total: number;
  distinctKeys: number;
}

/**
 * DuckDB has two readers and they are not interchangeable: `getRowsJson()`
 * returns positional arrays, `getRowObjectsJson()` returns column-keyed
 * objects. Reading the first as if it were the second yields `undefined` for
 * every column. Coercing that to 0 is what left the gate below comparing 0
 * to 0, so a missing column is an error here rather than a default.
 */
function readCount(row: Record<string, unknown> | undefined, column: string): number {
  const value = row?.[column];
  if (value === undefined || value === null) {
    throw new Error(`export: expected a ${column} count column, got none`);
  }
  return Number(value);
}

function firstRow(reader: RowReader): Record<string, unknown> | undefined {
  return reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
}

export function readCounts(reader: RowReader): UniquenessCounts {
  const row = firstRow(reader);
  return {
    total: readCount(row, "total"),
    distinctKeys: readCount(row, "distinct_keys"),
  };
}

export function readRowCount(reader: RowReader): number {
  return readCount(firstRow(reader), "n");
}

/**
 * Refuses a source that holds the same physical key twice — what a replayed
 * or reorged range leaves behind. Without it every aggregate downstream is
 * silently inflated.
 */
export function assertUniqueCounts(counts: UniquenessCounts): void {
  if (counts.total === counts.distinctKeys) return;
  throw new Error(
    JSON.stringify({
      code: "source_inconsistent",
      message: `duplicate physical keys: total=${counts.total} distinct=${counts.distinctKeys}`,
    }),
  );
}

export function buildUniquenessSql(
  networkName: string,
  contractName: string,
  event: string,
): string {
  const table = eventTableName(networkName, contractName, event);
  return `SELECT count(*)::bigint AS total, count(DISTINCT (contract_address, block_number, tx_hash, log_index))::bigint AS distinct_keys FROM pg.${table}`;
}

function workerLaunch(): { modulePath: string; execArgv: string[] } {
  const self = fileURLToPath(import.meta.url);
  const isTs = self.endsWith(".ts");
  const modulePath = fileURLToPath(
    new URL(isTs ? "./exportWorkerMain.ts" : "./exportWorkerMain.js", import.meta.url),
  );
  const execArgv =
    isTs && !process.features.typescript ? ["--experimental-strip-types"] : [];
  return { modulePath, execArgv };
}

function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export interface ExportResult {
  parquetPath: string;
  rowCount: number;
}

export async function exportEventTable(
  job: BoundedJob,
  outDir: string,
): Promise<ExportResult> {
  // One parquet per event. apply fans a multi-event source out into one job
  // per event before calling this; a job carrying several would silently
  // export only the first, so it is refused rather than guessed at.
  if (job.events.length !== 1) {
    throw new Error(
      `exportEventTable expects exactly one event per job, got ${job.events.length} for ${job.sourceId}`,
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  const req: ExportRequest = {
    databaseUrl: job.databaseUrl,
    networkName: job.networkName,
    contractName: job.contractName,
    event: job.events[0],
    chainId: job.chainId,
    // The file name is chainplot's own convention (documented in the
    // templates' `snapshot:` paths); only the table it reads from follows
    // rindexer's snake_case naming, via eventTableName.
    outPath: path.join(outDir, `${job.contractName}_${job.events[0].toLowerCase()}.parquet`),
  };
  const { modulePath, execArgv } = workerLaunch();
  return await new Promise<ExportResult>((resolve, reject) => {
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
      finish(new Error("export deadline exceeded"));
    }, 120_000);

    function finish(err: Error | null, value?: ExportResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as ExportResult);
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      let payload: { ok: boolean; rowCount?: number; message?: string } | null =
        null;
      try {
        payload = JSON.parse(stdout.trim().split("\n").pop() ?? "null");
      } catch {
        payload = null;
      }
      if (payload?.ok === true && typeof payload.rowCount === "number") {
        finish(null, { parquetPath: req.outPath, rowCount: payload.rowCount });
        return;
      }
      const detail =
        payload?.message ??
        stderr.trim() ??
        `export worker exited with code ${code ?? "unknown"}`;
      finish(new Error(detail));
    });

    child.stdin?.write(JSON.stringify(req) + "\n");
    child.stdin?.end();
  });
}
