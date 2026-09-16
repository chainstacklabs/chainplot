import fs from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildExportSql, type ExportRequest } from "./exporter.js";

async function readRequest(): Promise<ExportRequest> {
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      return JSON.parse(buf.slice(0, nl)) as ExportRequest;
    }
  }
  if (!buf) {
    throw new Error("empty export worker request");
  }
  return JSON.parse(buf) as ExportRequest;
}

async function execute(req: ExportRequest): Promise<number> {
  const instance = await DuckDBInstance.create(":memory:");
  try {
    const conn = await instance.connect();
    try {
      const statements = buildExportSql(req)
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i];
        if (i === 3) {
          const reader = await conn.runAndReadAll(sql);
          const rows = reader.getRowsJson() as unknown as {
            total: bigint | number;
            distinct_keys: bigint | number;
          }[];
          const total = Number(rows[0]?.total ?? 0);
          const distinctKeys = Number(rows[0]?.distinct_keys ?? 0);
          if (total !== distinctKeys) {
            throw new Error(
              JSON.stringify({
                code: "source_inconsistent",
                message: `duplicate physical keys: total=${total} distinct=${distinctKeys}`,
              }),
            );
          }
        } else if (i === statements.length - 1) {
          const reader = await conn.runAndReadAll(sql);
          const rows = reader.getRowsJson() as unknown as { n: bigint | number }[];
          return Number(rows[0]?.n ?? 0);
        } else {
          await conn.run(sql);
        }
      }
      throw new Error("unreachable");
    } finally {
      conn.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

function reply(payload: unknown, exitCode: number): void {
  fs.writeSync(1, JSON.stringify(payload) + "\n");
  process.exit(exitCode);
}

try {
  const req = await readRequest();
  const rowCount = await execute(req);
  reply({ ok: true, rowCount }, 0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  reply({ ok: false, message }, 1);
}
