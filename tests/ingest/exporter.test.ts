import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  assertUniqueCounts,
  buildExportSql,
  buildUniquenessSql,
  readCounts,
  readRowCount,
  snapshotFileName,
} from "../../src/ingest/exporter.js";

const req = {
  databaseUrl: "postgres://u:p@localhost:5432/chainplot",
  networkName: "chainplot_1",
  contractName: "usdc",
  event: "Transfer",
  chainId: 1,
  outPath: "/out/transfer.parquet",
};

describe("exporter SQL", () => {
  const sql = buildExportSql(req);

  it("attaches postgres read-only", () => {
    expect(sql).toContain("ATTACH 'postgres://u:p@localhost:5432/chainplot'");
    expect(sql).toContain("TYPE POSTGRES");
    expect(sql).toContain("READ_ONLY");
  });

  it("casts numeric columns to BIGINT (scanner maps numeric to DOUBLE)", () => {
    expect(sql).toContain("CAST(block_number AS BIGINT)");
    expect(sql).toContain("CAST(tx_index AS BIGINT)");
  });

  it("adds chain_id as a literal column", () => {
    expect(sql).toContain("1 AS chain_id");
  });

  it("copies to parquet at the requested path", () => {
    expect(sql).toContain("TO '/out/transfer.parquet'");
    expect(sql).toContain("FORMAT PARQUET");
  });

  it("uniqueness gate uses the physical unique key", () => {
    const u = buildUniquenessSql("chainplot_1", "usdc", "Transfer");
    expect(u).toContain("count(*)::bigint AS total");
    expect(u).toContain(
      "count(DISTINCT (contract_address, block_number, tx_hash, log_index))",
    );
  });

  it("escapes single quotes in the connection string", () => {
    const escaped = buildExportSql({ ...req, outPath: "/o'brien.parquet" });
    expect(escaped).toContain("'/o''brien.parquet'");
  });

  it("is deterministic", () => {
    expect(buildExportSql(req)).toBe(sql);
  });
});

describe("reading DuckDB results", () => {
  // `getRowsJson()` returns positional arrays. Reading it as objects yields
  // undefined for every column, which used to be coerced to 0 — leaving the
  // uniqueness gate below comparing 0 to 0, so it could never fire.
  async function query(sql: string) {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    return { reader: await conn.runAndReadAll(sql), conn, instance };
  }

  it("reads the uniqueness counts by column name", async () => {
    const { reader } = await query(
      "SELECT 42::bigint AS total, 7::bigint AS distinct_keys",
    );
    expect(readCounts(reader)).toEqual({ total: 42, distinctKeys: 7 });
  });

  it("reads the exported row count by column name", async () => {
    const { reader } = await query("SELECT 20618::bigint AS n");
    expect(readRowCount(reader)).toBe(20618);
  });

  it("refuses a missing column rather than calling it zero", async () => {
    const { reader } = await query("SELECT 1 AS something_else");
    expect(() => readRowCount(reader)).toThrow(/count/i);
  });
});

describe("the uniqueness gate", () => {
  it("passes when every physical key is distinct", () => {
    expect(() => assertUniqueCounts({ total: 20618, distinctKeys: 20618 })).not.toThrow();
  });

  it("fires when a physical key is duplicated", () => {
    expect(() => assertUniqueCounts({ total: 3, distinctKeys: 2 })).toThrow(
      /source_inconsistent/,
    );
  });

  it("fires on a table that actually holds a duplicated row", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    await conn.run("ATTACH ':memory:' AS pg");
    await conn.run("CREATE SCHEMA pg.chainplot_chainplot_1_usdc");
    await conn.run(
      "CREATE TABLE pg.chainplot_chainplot_1_usdc.transfer " +
        "(contract_address VARCHAR, block_number BIGINT, tx_hash VARCHAR, log_index BIGINT)",
    );
    // Same (address, block, tx, log_index) twice: what a replayed range leaves behind.
    await conn.run(
      "INSERT INTO pg.chainplot_chainplot_1_usdc.transfer VALUES " +
        "('0xa', 1, '0xb', 0), ('0xa', 1, '0xb', 0), ('0xa', 2, '0xc', 0)",
    );
    const reader = await conn.runAndReadAll(
      buildUniquenessSql("chainplot_1", "usdc", "Transfer"),
    );
    const counts = readCounts(reader);
    expect(counts).toEqual({ total: 3, distinctKeys: 2 });
    expect(() => assertUniqueCounts(counts)).toThrow(/duplicate physical keys/);
  });
});

// The snapshot is named the way rindexer names the table it came from, so a
// `snapshot:` path follows from the event name by one rule, not two.
describe("snapshotFileName", () => {
  it("is unchanged for the single-word events every template uses", () => {
    expect(snapshotFileName("usdc", "Transfer")).toBe("usdc_transfer.parquet");
    expect(snapshotFileName("weth", "Withdrawal")).toBe("weth_withdrawal.parquet");
  });

  it("snake_cases a multi-word event exactly as the table is named", () => {
    expect(snapshotFileName("steth", "TransferShares")).toBe("steth_transfer_shares.parquet");
    expect(snapshotFileName("erc20dep", "RelayERC20Deposit")).toBe(
      "erc_20dep_relay_erc_20_deposit.parquet",
    );
  });
});
