import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runBounded,
  stopAndQuiesce,
} from "../../src/ingest/rindexer/runBounded.js";
import type { BoundedJob } from "../../src/ingest/adapter.js";

const fakeBin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../helpers/fakeRindexer.mjs",
);

function makeJob(workDir: string): BoundedJob {
  return {
    sourceId: "src",
    contractName: "usdc",
    networkName: "chainplot_1",
    chainId: 1,
    addresses: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
    abiPath: path.join(workDir, "abis/ERC20.json"),
    events: ["Transfer"],
    jobStart: 100,
    jobEnd: 110,
    rpcUrl: "http://rpc.example",
    databaseUrl: "postgres://u:p@localhost:5432/chainplot",
    workDir,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-run-"));
}

describe("runBounded", () => {
  it("writes the generated config and detects historic complete", async () => {
    const workDir = tempDir();
    const job = makeJob(workDir);
    const handle = await runBounded(
      { ...job, rpcUrl: "", databaseUrl: "" },
      { rindexerBin: `node ${fakeBin}`, wallClockMs: 10_000 },
      { fakeMode: "complete" },
    );
    expect(handle.completedLogSeen).toBe(true);
    expect(fs.existsSync(path.join(workDir, "rindexer.yaml"))).toBe(true);
    await stopAndQuiesce(handle);
  }, 15_000);

  it("rejects a child that exits before the completed line", async () => {
    const workDir = tempDir();
    const job = makeJob(workDir);
    await expect(
      runBounded(
        { ...job, rpcUrl: "", databaseUrl: "" },
        { rindexerBin: `node ${fakeBin}`, wallClockMs: 10_000 },
        { fakeMode: "exit" },
      ),
    ).rejects.toMatchObject({ retryable: true });
  }, 15_000);

  it("wall clock exceeded → retryable failure, child killed", async () => {
    const workDir = tempDir();
    const job = makeJob(workDir);
    await expect(
      runBounded(
        { ...job, rpcUrl: "", databaseUrl: "" },
        { rindexerBin: `node ${fakeBin}`, wallClockMs: 300 },
        { fakeMode: "hang" },
      ),
    ).rejects.toMatchObject({ retryable: true });
  }, 10_000);
});
