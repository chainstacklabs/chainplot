import fs from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  assertUniqueCounts,
  buildExportSql,
  readCounts,
  readRowCount,
  type ExportRequest,
} from "./exporter.js";

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
          assertUniqueCounts(readCounts(await conn.runAndReadAll(sql)));
        } else if (i === statements.length - 1) {
          return readRowCount(await conn.runAndReadAll(sql));
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
