import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliJson } from "../helpers/run.js";
import { applyPlan } from "../../src/plan/apply.js";
import type { BoundedJob, IngestAdapter, CoverageReport } from "../../src/ingest/adapter.js";
import type { RpcClient } from "../../src/rpc/client.js";
import type { ProjectDocument } from "../../src/project/types.js";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

const INGEST_YAML = [
  "format_version: 1",
  'id: "runs-test"',
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-runs-"));
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

describe("runs commands", () => {
  it("list/show roundtrip on a seeded run", async () => {
    const cwd = setupProject();
    const runDir = path.join(cwd, ".chainplot", "runs", "k1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        status: "succeeded",
        plan_id: "k1",
        plan_digest: "k1",
        updated_at: "2026-09-13T00:00:00Z",
      }),
    );
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ schema_version: 1 }));

    const listed = await runCliJson(["runs", "list", "--json"], cwd);
    expect(listed.ok).toBe(true);
    expect(listed.data).toMatchObject({
      runs: [{ idempotency_key: "k1", status: "succeeded" }],
    });

    const shown = await runCliJson(["runs", "show", "k1", "--json"], cwd);
    expect(shown.ok).toBe(true);
    expect(shown.data).toMatchObject({ idempotency_key: "k1" });

    const missing = await runCliJson(["runs", "show", "nope", "--json"], cwd);
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("validation");
  });

  it("cancel writes the flag; cancel of succeeded run → validation", async () => {
    const cwd = setupProject();
    const runDir = path.join(cwd, ".chainplot", "runs", "k2");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        status: "running",
        plan_id: "k2",
        plan_digest: "k2",
        updated_at: "2026-09-13T00:00:00Z",
      }),
    );
    const canceled = await runCliJson(["runs", "cancel", "k2", "--json"], cwd);
    expect(canceled.ok).toBe(true);
    expect(fs.existsSync(path.join(runDir, "cancel_requested"))).toBe(true);

    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        status: "succeeded",
        plan_id: "k2",
        plan_digest: "k2",
        updated_at: "2026-09-13T00:00:01Z",
      }),
    );
    const tooLate = await runCliJson(["runs", "cancel", "k2", "--json"], cwd);
    expect(tooLate.ok).toBe(false);
    expect(tooLate.error?.code).toBe("validation");
  });
});

describe("progress events", () => {
  it("applyPlan emits stage events via onProgress", async () => {
    const cwd = setupProject();
    process.env.RPC_URL = "http://rpc.test";
    process.env.DATABASE_URL = "postgres://test@localhost/db";
    const { generatePlan } = await import("../../src/plan/generate.js");
    const { parse } = await import("yaml");
    const project = parse(INGEST_YAML) as ProjectDocument;
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project,
      rpcClient: {
        async call<T>() {
          return {
            number: "0xc8",
            hash: H(200),
            parentHash: H(199),
          } as T;
        },
      },
    });
    const report: CoverageReport = {
      status: "complete_with_rows",
      lastSyncedBlock: 110,
      rowCount: 92,
    };
    const adapter: IngestAdapter = {
      renderConfig: () => "fake",
      runBounded: async (job: BoundedJob) => ({ job, pid: -1, completedLogSeen: true }),
      stopAndQuiesce: async () => {},
      inspectCoverage: async () => report,
    };
    const stages: string[] = [];
    await applyPlan({
      cwd,
      planRef: planPath,
      adapter,
      exportFn: async (_job, outDir) => ({
        parquetPath: path.join(outDir, "usdc_transfer.parquet"),
        rowCount: 92,
      }),
      buildFn: async () => ({ distDir: path.join(cwd, "dist/releases/local") }),
      rindexerBin: "rindexer",
      rpcClient: {
        async call<T>(method: string, params: unknown[]) {
          const tag = params[0] as string;
          const n = tag === "finalized" ? 200 : Number(BigInt(tag));
          return { number: "0x" + n.toString(16), hash: H(n), parentHash: H(n - 1) } as T;
        },
      },
      onProgress: (e) => stages.push(e.stage),
    });
    expect(stages).toEqual([
      "plan_verified",
      "ingest_started",
      "ingest_completed",
      "coverage_recorded",
      "export_completed",
      "release_written",
    ]);
  });
});
