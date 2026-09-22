import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { runQuery } from "../../src/query/runQuery.js";

// A snapshot shaped like rindexer's export: block_timestamp is TIMESTAMP WITH
// TIME ZONE. Written by this test process, not the worker, which has external
// access switched off before any project SQL runs.
async function timestampFixture(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-tz-"));
  const parquet = path.join(dir, "events.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(
    `COPY (
       SELECT * FROM (VALUES
         (1, TIMESTAMPTZ '2026-09-16 00:26:20+00'),
         (2, TIMESTAMPTZ '2026-09-16 23:59:59+00')
       ) AS t(rindexer_id, block_timestamp)
     ) TO '${parquet.replaceAll("'", "''")}' (FORMAT PARQUET)`,
  );
  return parquet;
}

// DuckDB formats, casts and buckets TIMESTAMPTZ in the session TimeZone, which
// follows the machine unless pinned: the same query would publish "08:00" from
// a laptop in Singapore and "00:00" from the producer container. The worker
// pins UTC so a fork reproduces the published figures wherever it runs.
describe("query session timezone", () => {
  // TimeZone is a setting DuckDB's ICU extension registers, so reading it
  // back also proves the bundled build links ICU: without it the worker's
  // SET would have failed before this query ran. (duckdb_extensions() is not
  // usable here: it scans the extension directory, which the worker's
  // external-access lockdown forbids.)
  it("is pinned to UTC by the ICU-backed setting", async () => {
    const parquet = await timestampFixture();
    const result = await runQuery({
      sql: "SELECT current_setting('TimeZone') AS tz FROM (SELECT 1)",
      tables: { events: parquet },
      rawAmountColumns: [],
      rowLimit: 10,
    });
    expect(result.rows).toEqual([["UTC"]]);
  });

  it("renders, buckets and casts a TIMESTAMPTZ column in UTC", async () => {
    const parquet = await timestampFixture();
    const result = await runQuery({
      sql: `SELECT typeof(block_timestamp) AS t,
                   strftime(block_timestamp, '%Y-%m-%d %H:%M:%S') AS rendered,
                   strftime(date_trunc('day', block_timestamp), '%Y-%m-%d') AS day,
                   hour(block_timestamp) AS h,
                   strftime(block_timestamp::TIMESTAMP, '%H:%M') AS cast_naive
            FROM events ORDER BY rindexer_id`,
      tables: { events: parquet },
      rawAmountColumns: [],
      rowLimit: 10,
    });
    expect(result.rows).toEqual([
      // hour() is BIGINT, which the worker serializes as a decimal string.
      ["TIMESTAMP WITH TIME ZONE", "2026-09-16 00:26:20", "2026-09-16", "0", "00:26"],
      ["TIMESTAMP WITH TIME ZONE", "2026-09-16 23:59:59", "2026-09-16", "23", "23:59"],
    ]);
  });
});
