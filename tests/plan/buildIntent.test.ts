import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

const INGEST_YAML = [
  "format_version: 1",
  'id: "build-intent"',
  "chain_sources:",
  "  - id: mainnet",
  "    chain_id: 1",
  "    rpc_secret: RPC_URL",
  "    finality:",
  "      policy: finalized",
  "event_sources:",
  "  - id: usdc",
  "    chain: mainnet",
  "    addresses:",
  '      - "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"',
  "    abi: abis/ERC20.json",
  "    events:",
  "      - Transfer",
  "    start_block: 100",
  "    end:",
  "      mode: pinned",
  "      block: 110",
  "datasets:",
  "  - id: usdc",
  "    snapshot: .chainplot/snapshots/usdc/usdc_transfer.parquet",
  "queries:",
  "  - id: count",
  "    file: queries/count.sql",
  "    dataset: usdc",
].join("\n");

function setupProject(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-buildplan-"));
  fs.mkdirSync(path.join(cwd, "abis"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "chainplot.yaml"), INGEST_YAML + "\n");
  fs.writeFileSync(path.join(cwd, "abis/ERC20.json"), "[]");
  fs.writeFileSync(path.join(cwd, "queries/count.sql"), "select count(*) as n from usdc");
  fs.mkdirSync(path.join(cwd, ".chainplot/snapshots/usdc"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".chainplot/snapshots/usdc/usdc_transfer.parquet"),
    "PK\x03\x04dummy",
  );
  return cwd;
}

function writeCompleteCoverage(cwd: string): void {
  fs.mkdirSync(path.join(cwd, ".chainplot"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".chainplot/coverage.json"),
    JSON.stringify({
      schema_version: 1,
      chain_id: 1,
      sources: [
        {
          source_id: "usdc",
          segments: [
            {
              start_block: 100,
              end_block: 110,
              start_block_hash: H(100),
              end_block_hash: H(110),
              start_block_parent_hash: H(99),
              status: "complete_with_rows",
              row_count: 92,
            },
          ],
        },
      ],
    }),
  );
}

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    RPC_URL: process.env.RPC_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };
  delete process.env.RPC_URL;
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("plan --intent build", () => {
  it("no credentials, no RPC, build_results only", async () => {
    const cwd = setupProject();
    writeCompleteCoverage(cwd);
    const result = await runCliJson(["plan", "--intent", "build", "--json"], cwd);
    expect(result.ok).toBe(true);
    const data = result.data as {
      actions: { type: string }[];
      sources: { job_start: number; job_end: number }[];
    };
    expect(data.actions).toEqual([{ type: "build_results" }]);
    expect(data.sources[0].job_start).toBe(111);
    expect(data.sources[0].job_end).toBe(110);
  });

  it("publish intent without a target → policy_refused", async () => {
    const cwd = setupProject();
    const result = await runCliJson(["plan", "--intent", "publish", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
  });

  it("dataset-only project → build plan with null chain", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-buildplan-"));
    fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "chainplot.yaml"),
      [
        "format_version: 1",
        'id: "fixture"',
        "datasets:",
        "  - id: amounts",
        "    snapshot: snapshots/amounts.parquet",
        "queries:",
        "  - id: raw_amounts",
        "    file: queries/raw_amounts.sql",
        "    dataset: amounts",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(cwd, "snapshots"), { recursive: true });
    fs.copyFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../templates/fixture-transfers/snapshots/amounts.parquet",
      ),
      path.join(cwd, "snapshots/amounts.parquet"),
    );
    fs.writeFileSync(path.join(cwd, "queries/raw_amounts.sql"), "select 1 as x");
    const result = await runCliJson(["plan", "--intent", "build", "--json"], cwd);
    expect(result.ok).toBe(true);
    expect((result.data as { chain: unknown }).chain).toBeNull();
  });
});
