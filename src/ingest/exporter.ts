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
  fs.mkdirSync(outDir, { recursive: true });
  const req: ExportRequest = {
    databaseUrl: job.databaseUrl,
    networkName: job.networkName,
    contractName: job.contractName,
    event: job.events[0],
    chainId: job.chainId,
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
