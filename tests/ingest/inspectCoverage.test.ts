import { describe, expect, it } from "vitest";
import {
  assertValidJobIdentifiers,
  type BoundedJob,
} from "../../src/ingest/adapter.js";
import {
  cursorTableName,
  eventTableName,
  classifyCoverage,
  buildCursorQuery,
  buildRowCountQuery,
} from "../../src/ingest/rindexer/inspectCoverage.js";

function job(overrides: Partial<BoundedJob> = {}): BoundedJob {
  return {
    sourceId: "src",
    contractName: "usdc",
    networkName: "chainplot_1",
    chainId: 1,
    addresses: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
    abiPath: "/p/abis/x.json",
    events: ["Transfer"],
    jobStart: 100,
    jobEnd: 110,
    rpcUrl: "http://r",
    databaseUrl: "postgres://u:p@h/db",
    workDir: "/w",
    ...overrides,
  };
}

describe("coverage evidence naming", () => {
  it("cursor table follows rindexer_internal.{manifest_name}_{contract}_{event}", () => {
    expect(cursorTableName("chainplot_1", "usdc", "Transfer")).toBe(
      "rindexer_internal.chainplot_chainplot_1_usdc_transfer",
    );
    expect(eventTableName("chainplot_1", "usdc", "Transfer")).toBe(
      "chainplot_chainplot_1_usdc.transfer",
    );
  });

  it("rejects identifiers that are not [a-z0-9_]", () => {
    expect(() =>
      assertValidJobIdentifiers(job({ contractName: "Usdc; DROP" })),
    ).toThrow();
    expect(() =>
      assertValidJobIdentifiers(job({ networkName: "chainplot 1" })),
    ).toThrow();
    expect(() => assertValidJobIdentifiers(job())).not.toThrow();
  });

  it("cursor table follows rindexer manifest-name convention", () => {
    expect(cursorTableName("chainplot_1", "usdc", "Transfer")).toBe(
      "rindexer_internal.chainplot_chainplot_1_usdc_transfer",
    );
    expect(eventTableName("chainplot_1", "usdc", "Transfer")).toBe(
      "chainplot_chainplot_1_usdc.transfer",
    );
  });

  it("rejects identifiers that are not [a-z0-9_]", () => {
    expect(() =>
      assertValidJobIdentifiers(job({ contractName: "Usdc; DROP" })),
    ).toThrow();
    expect(() => assertValidJobIdentifiers(job())).not.toThrow();
  });

  it("queries are parameterized or identifier-safe", () => {
    const q = buildCursorQuery("chainplot_1", "usdc", "Transfer");
    expect(q.text).toBe(
      "SELECT last_synced_block FROM rindexer_internal.chainplot_chainplot_1_usdc_transfer WHERE network = $1",
    );
    expect(q.params).toEqual(["chainplot_1"]);
    expect(buildRowCountQuery("chainplot_1", "usdc", "Transfer")).toBe(
      "SELECT count(*)::bigint AS n FROM chainplot_chainplot_1_usdc.transfer",
    );
  });
});

describe("classifyCoverage", () => {
  it("no cursor row → not_indexed", () => {
    expect(classifyCoverage(null, 0, 110)).toEqual({
      status: "not_indexed",
      lastSyncedBlock: null,
      rowCount: 0,
    });
  });

  it("cursor below job end → incomplete", () => {
    expect(classifyCoverage(109, 500, 110)).toEqual({
      status: "incomplete",
      lastSyncedBlock: 109,
      rowCount: 500,
    });
  });

  it("cursor at end with zero rows → complete_empty (A6)", () => {
    expect(classifyCoverage(110, 0, 110)).toEqual({
      status: "complete_empty",
      lastSyncedBlock: 110,
      rowCount: 0,
    });
  });

  it("cursor at end with rows → complete_with_rows", () => {
    expect(classifyCoverage(110, 92, 110)).toEqual({
      status: "complete_with_rows",
      lastSyncedBlock: 110,
      rowCount: 92,
    });
  });

  it("cursor beyond end with rows → complete_with_rows", () => {
    expect(classifyCoverage(120, 7, 110).status).toBe("complete_with_rows");
  });
});
