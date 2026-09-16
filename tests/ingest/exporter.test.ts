import { describe, expect, it } from "vitest";
import {
  buildExportSql,
  buildUniquenessSql,
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
