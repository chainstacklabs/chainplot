import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePlan } from "../../src/plan/generate.js";
import { applyPlan } from "../../src/plan/apply.js";
import type {
  BoundedJob,
  IngestAdapter,
  CoverageReport,
} from "../../src/ingest/adapter.js";
import type { RpcClient } from "../../src/rpc/client.js";
import { RpcError } from "../../src/rpc/client.js";
import type { ProjectDocument } from "../../src/project/types.js";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function mockRpc(head: number, calls: string[]): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(`${method}:${String(params[0])}`);
      const tag = params[0] as string;
      const n = tag === "finalized" ? head : Number(BigInt(tag));
      return {
        number: "0x" + n.toString(16),
        hash: H(n),
        parentHash: H(n - 1),
      } as T;
    },
  };
}

interface FakeState {
  runs: BoundedJob[];
  exports: string[];
  coverageReport: CoverageReport;
}

function fakeAdapter(state: FakeState): IngestAdapter {
  return {
    renderConfig: () => "fake-config",
    runBounded: async (job) => {
      state.runs.push(job);
      return { job, pid: -1, completedLogSeen: true };
    },
    stopAndQuiesce: async () => {},
    inspectCoverage: async (job) => ({
      ...state.coverageReport,
      lastSyncedBlock: Math.max(
        state.coverageReport.lastSyncedBlock ?? 0,
        job.jobEnd,
      ),
    }),
  };
}

const PROJECT_YAML = [
  "format_version: 1",
  'id: "ingest-test"',
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

function makeProject(cwd: string): ProjectDocument {
  void cwd;
  return {
    format_version: 1,
    id: "ingest-test",
    chain_sources: [
      {
        id: "mainnet",
        chain_id: 1,
        rpc_secret: "RPC_URL",
        finality: { policy: "finalized" },
      },
    ],
    event_sources: [
      {
        id: "usdc",
        chain: "mainnet",
        addresses: ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
        abi: "abis/ERC20.json",
        events: ["Transfer"],
        start_block: 100,
        end: { mode: "pinned", block: 110 },
      },
    ],
    datasets: [
      {
        id: "usdc",
        snapshot: ".chainplot/snapshots/usdc/usdc_transfer.parquet",
      },
    ],
    queries: [{ id: "count", file: "queries/count.sql", dataset: "usdc" }],
  };
}

function setupProject(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-plan-"));
  fs.mkdirSync(path.join(cwd, "abis"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "chainplot.yaml"), PROJECT_YAML + "\n");
  fs.writeFileSync(path.join(cwd, "abis/ERC20.json"), "[]");
  fs.writeFileSync(path.join(cwd, "queries/count.sql"), "select count(*) as n from usdc");
  fs.mkdirSync(path.join(cwd, ".chainplot/snapshots/usdc"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".chainplot/snapshots/usdc/usdc_transfer.parquet"),
    "dummy",
  );
  return cwd;
}

function fakeExport(state: FakeState) {
  return async (_job: BoundedJob, outDir: string) => {
    state.exports.push(outDir);
    return {
      parquetPath: path.join(outDir, "usdc_transfer.parquet"),
      rowCount: 92,
    };
  };
}

describe("generatePlan", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { RPC_URL: process.env.RPC_URL, DATABASE_URL: process.env.DATABASE_URL };
    process.env.RPC_URL = "http://rpc.test";
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("pinned happy path: bounds, actions, plan file", async () => {
    const cwd = setupProject();
    const calls: string[] = [];
    const { plan, planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, calls),
    });
    expect(plan.sources[0]).toMatchObject({
      source_id: "usdc",
      job_start: 100,
      job_end: 110,
      job_target_end: 110,
      blocks_remaining: 11,
    });
    expect(plan.actions).toEqual([
      { type: "ingest", source_id: "usdc" },
      { type: "export", source_id: "usdc" },
      { type: "build_results" },
    ]);
    expect(fs.existsSync(planPath)).toBe(true);
    expect(plan.plan_id).toMatch(/^[0-9a-f]{64}$/);
  });

  // A backfill wider than the block budget is split across runs. While an
  // intermediate plan still carried build_results, `apply` ingested
  // successfully and then failed on the promotion gate, reporting the whole
  // run as failed and making a long backfill look like it was going nowhere.
  it("a plan that cannot close the range ingests only", async () => {
    const cwd = setupProject();
    const project = makeProject(cwd);
    project.policy = { block_budget: 3 };
    const { plan } = await generatePlan({
      intent: "ingest",
      cwd,
      project,
      rpcClient: mockRpc(200, []),
    });
    expect(plan.sources[0]!.job_end).toBe(102);
    expect(plan.sources[0]!.job_target_end).toBe(110);
    // Export and build both sit behind the promotion gate, so an intermediate
    // run must not claim them: it would ingest correctly and then fail.
    expect(plan.actions).toEqual([{ type: "ingest", source_id: "usdc" }]);
  });

  it("a build intent still builds even when coverage is short", async () => {
    const cwd = setupProject();
    const { plan } = await generatePlan({
      intent: "build",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    // An explicit build deserves the promotion gate's own error, not a plan
    // that quietly does nothing.
    expect(plan.actions).toEqual([{ type: "build_results" }]);
  });

  it("pinned end above finalized head → policy_refused", async () => {
    const cwd = setupProject();
    const project = makeProject(cwd);
    project.event_sources![0].end = { mode: "pinned", block: 250 };
    await expect(
      generatePlan({
        intent: "ingest",
        cwd,
        project,
        rpcClient: mockRpc(200, []),
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("block budget caps job_end", async () => {
    const cwd = setupProject();
    const project = makeProject(cwd);
    project.policy = { block_budget: 5 };
    const { plan } = await generatePlan({
      intent: "ingest",
      cwd,
      project,
      rpcClient: mockRpc(200, []),
    });
    expect(plan.sources[0].job_end).toBe(104);
    expect(plan.sources[0].blocks_remaining).toBe(11);
  });

  it("follow_finalized resolves the finalized head", async () => {
    const cwd = setupProject();
    const project = makeProject(cwd);
    project.event_sources![0].end = { mode: "follow_finalized" };
    const { plan } = await generatePlan({
      intent: "ingest",
      cwd,
      project,
      rpcClient: mockRpc(200, []),
    });
    expect(plan.sources[0].job_target_end).toBe(200);
    expect(plan.sources[0].job_end).toBe(200);
  });

  it("complete pinned source → no RPC, no ingest action", async () => {
    const cwd = setupProject();
    const calls: string[] = [];
    writeCoverage(cwd, [segment(100, 110)]);
    const { plan } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, calls),
    });
    expect(calls).toEqual([]);
    expect(plan.actions).toEqual([{ type: "build_results" }]);
    expect(plan.sources[0].job_start).toBe(111);
    expect(plan.sources[0].job_end).toBe(110);
  });
});

describe("applyPlan", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = { RPC_URL: process.env.RPC_URL, DATABASE_URL: process.env.DATABASE_URL };
    process.env.RPC_URL = "http://rpc.test";
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function completeReport(): CoverageReport {
    return { status: "complete_with_rows", lastSyncedBlock: 110, rowCount: 92 };
  }

  it("happy path: ingest, export, coverage recorded", async () => {
    const cwd = setupProject();
    const state: FakeState = { runs: [], exports: [], coverageReport: completeReport() };
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    const outcome = await applyPlan({
      cwd,
      planRef: planPath,
      adapter: fakeAdapter(state),
      exportFn: fakeExport(state),
      buildFn: fakeBuild(),
      rindexerBin: "rindexer",
      rpcClient: mockRpc(200, []),
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.reused).toBe(false);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({ jobStart: 100, jobEnd: 110 });
    expect(state.exports).toHaveLength(1);
    const coverage = readCoverage(cwd);
    expect(coverage.sources[0].segments).toEqual([
      expect.objectContaining({
        start_block: 100,
        end_block: 110,
        status: "complete_with_rows",
        row_count: 92,
      }),
    ]);
  });

  it("same key re-apply → reused outcome, no second run", async () => {
    const cwd = setupProject();
    const state: FakeState = { runs: [], exports: [], coverageReport: completeReport() };
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    const opts = {
      cwd,
      planRef: planPath,
      adapter: fakeAdapter(state),
      exportFn: fakeExport(state),
      buildFn: fakeBuild(),
      rindexerBin: "rindexer",
      rpcClient: mockRpc(200, []),
    };
    await applyPlan(opts);
    const second = await applyPlan(opts);
    expect(second.reused).toBe(true);
    expect(state.runs).toHaveLength(1);
  });

  it("configuration drift → policy_refused", async () => {
    const cwd = setupProject();
    const state: FakeState = { runs: [], exports: [], coverageReport: completeReport() };
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    fs.appendFileSync(path.join(cwd, "chainplot.yaml"), "\n");
    await expect(
      applyPlan({
        cwd,
        planRef: planPath,
        adapter: fakeAdapter(state),
        buildFn: fakeBuild(),
        rindexerBin: "rindexer",
        rpcClient: mockRpc(200, []),
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("state drift (coverage changed) → policy_refused", async () => {
    const cwd = setupProject();
    writeCoverage(cwd, [segment(100, 110)]);
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    fs.rmSync(path.join(cwd, ".chainplot/coverage.json"));
    const state: FakeState = { runs: [], exports: [], coverageReport: completeReport() };
    await expect(
      applyPlan({
        cwd,
        planRef: planPath,
        adapter: fakeAdapter(state),
        buildFn: fakeBuild(),
        rindexerBin: "rindexer",
        rpcClient: mockRpc(200, []),
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("hash-join break → source_inconsistent, coverage unchanged", async () => {
    const cwd = setupProject();
    const state: FakeState = { runs: [], exports: [], coverageReport: completeReport() };
    // Seed a prior segment ending at 99 BEFORE planning (assumption: proven=99,
    // same as no coverage — but gives apply a tail to hash-join against).
    writeCoverage(cwd, [segment(0, 99)]);
    const { planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: makeProject(cwd),
      rpcClient: mockRpc(200, []),
    });
    // Breaking rpc: hashes do not chain (block n hash ≠ H(n)).
    const breakingRpc: RpcClient = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        const tag = params[0] as string;
        const n = tag === "finalized" ? 200 : Number(BigInt(tag));
        return {
          number: "0x" + n.toString(16),
          hash: H(n * 7 + 1),
          parentHash: H(n * 7),
        } as T;
      },
    };
    await expect(
      applyPlan({
        cwd,
        planRef: planPath,
        adapter: fakeAdapter(state),
        exportFn: fakeExport(state),
        buildFn: fakeBuild(),
        rindexerBin: "rindexer",
        rpcClient: breakingRpc,
      }),
    ).rejects.toMatchObject({ code: "source_inconsistent" });
    const coverage = readCoverage(cwd);
    expect(coverage.sources[0].segments).toHaveLength(1);
    expect(coverage.sources[0].segments[0].end_block).toBe(99);
  });
});

function fakeBuild() {
  return async (cwd: string) => ({ distDir: path.join(cwd, "dist/releases/local") });
}

function segment(start: number, end: number) {
  return {
    start_block: start,
    end_block: end,
    start_block_hash: H(start),
    end_block_hash: H(end),
    start_block_parent_hash: H(start - 1),
    status: "complete_with_rows" as const,
    row_count: 5,
  };
}

function writeCoverage(cwd: string, segments: ReturnType<typeof segment>[]): void {
  fs.mkdirSync(path.join(cwd, ".chainplot"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".chainplot/coverage.json"),
    JSON.stringify({
      schema_version: 1,
      chain_id: 1,
      sources: [{ source_id: "usdc", segments }],
    }),
  );
}

function readCoverage(cwd: string): { sources: { source_id: string; segments: { end_block: number }[] }[] } {
  return JSON.parse(
    fs.readFileSync(path.join(cwd, ".chainplot/coverage.json"), "utf8"),
  );
}
