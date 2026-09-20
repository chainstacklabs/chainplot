import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliJson } from "../helpers/run.js";
import { runsCancel } from "../../src/cli/commands/runs.js";
import { generatePlan } from "../../src/plan/generate.js";
import { applyPlan } from "../../src/plan/apply.js";
import { journalDir, writeJournalStatus } from "../../src/runtime/journal.js";
import type { IngestAdapter, CoverageReport } from "../../src/ingest/adapter.js";
import type { RpcClient } from "../../src/rpc/client.js";
import type { ProjectDocument } from "../../src/project/types.js";

// `runs cancel` is documented as cooperative: it drops a flag and the running
// apply notices at its next checkpoint. Nothing exercised it, in either half —
// neither the flag nor the noticing.

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function mockRpc(head: number): RpcClient {
  return {
    call: async (method: string, params: unknown[]) => {
      if (method === "eth_blockNumber") return "0x" + head.toString(16);
      const tag = String((params as string[])[0]);
      const n = tag === "finalized" ? head : Number(BigInt(tag));
      return {
        number: "0x" + n.toString(16),
        hash: H(n),
        parentHash: H(n - 1),
        timestamp: "0x" + (1_700_000_000 + n).toString(16),
      };
    },
  } as unknown as RpcClient;
}

const YAML = [
  "format_version: 1",
  'id: "cancel-test"',
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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-cancel-"));
  fs.mkdirSync(path.join(cwd, "abis"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".chainplot/snapshots/usdc"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "chainplot.yaml"), `${YAML}\n`);
  fs.writeFileSync(path.join(cwd, "abis/ERC20.json"), "[]");
  fs.writeFileSync(path.join(cwd, "queries/count.sql"), "select count(*) as n from usdc");
  fs.writeFileSync(
    path.join(cwd, ".chainplot/snapshots/usdc/usdc_transfer.parquet"),
    "PK\x03\x04dummy",
  );
  return cwd;
}

function project(cwd: string): ProjectDocument {
  void cwd;
  return {
    format_version: 1,
    id: "cancel-test",
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
    datasets: [{ id: "usdc", snapshot: ".chainplot/snapshots/usdc/usdc_transfer.parquet" }],
    queries: [{ id: "count", file: "queries/count.sql", dataset: "usdc" }],
  };
}

const report: CoverageReport = {
  status: "complete_with_rows",
  lastSyncedBlock: 110,
  rowCount: 92,
};

/** Records whether ingest was ever reached. */
function adapter(reached: { ingest: boolean }): IngestAdapter {
  return {
    renderConfig: () => "fake",
    runBounded: async (job) => {
      reached.ingest = true;
      return { job, pid: -1, completedLogSeen: true };
    },
    stopAndQuiesce: async () => {},
    inspectCoverage: async () => report,
  } as unknown as IngestAdapter;
}

let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = { RPC_URL: process.env.RPC_URL, DATABASE_URL: process.env.DATABASE_URL };
  process.env.RPC_URL = "http://rpc.test";
  process.env.DATABASE_URL = "postgresql://u:u@127.0.0.1:1/u";
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("runs list / show", () => {
  it("lists nothing for a project that has never run", async () => {
    const cwd = setupProject();
    const result = await runCliJson(["runs", "list", "--json"], cwd);
    expect(result.ok).toBe(true);
    expect((result.data as { runs: unknown[] }).runs).toEqual([]);
  });

  it("show on an unknown key is a validation error, not a crash", async () => {
    const cwd = setupProject();
    const result = await runCliJson(["runs", "show", "nope", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
    expect(result.error?.suggested_next).toBe("runs list");
  });

  it("lists and shows a run once one exists", async () => {
    const cwd = setupProject();
    const { plan, planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: project(cwd),
      rpcClient: mockRpc(200),
    });
    await applyPlan({
      cwd,
      planRef: planPath,
      adapter: adapter({ ingest: false }),
      exportFn: async () => ({ rowCount: 92, parquetPath: "x.parquet" }),
      buildFn: async () => ({ distDir: "dist", files: [] }),
      rindexerBin: "rindexer",
      rpcClient: mockRpc(200),
    });

    const list = await runCliJson(["runs", "list", "--json"], cwd);
    const runs = (list.data as { runs: { idempotency_key: string; status: string }[] })
      .runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");

    const shown = await runCliJson(["runs", "show", runs[0]!.idempotency_key, "--json"], cwd);
    expect(shown.ok).toBe(true);
    expect((shown.data as { plan: { plan_id: string } }).plan.plan_id).toBe(plan.plan_id);
  });
});

describe("runs cancel", () => {
  it("refuses an unknown key", () => {
    const cwd = setupProject();
    const result = runsCancel(cwd, "nope");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("refuses a run that already succeeded", () => {
    const cwd = setupProject();
    writeJournalStatus(cwd, "k", {
      status: "succeeded",
      plan_id: "k",
      plan_digest: "k",
    });
    const result = runsCancel(cwd, "k");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/already succeeded/);
  });

  it("requests cancellation of a run still in flight", () => {
    const cwd = setupProject();
    writeJournalStatus(cwd, "k", { status: "running", plan_id: "k", plan_digest: "k" });
    const result = runsCancel(cwd, "k");
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(journalDir(cwd, "k"), "cancel_requested"))).toBe(true);
  });

  // A run whose process died leaves the journal saying "running", and apply
  // refuses to start while it does. Without a terminal state the project is
  // stranded with no way back.
  it("moves an abandoned run to a terminal state so apply can run again", async () => {
    const cwd = setupProject();
    const { plan, planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: project(cwd),
      rpcClient: mockRpc(200),
    });
    // Simulate a killed apply: status left at running, no flag.
    writeJournalStatus(cwd, plan.plan_id!, {
      status: "running",
      plan_id: plan.plan_id!,
      plan_digest: plan.plan_id!,
    });
    await expect(
      applyPlan({
        cwd,
        planRef: planPath,
        adapter: adapter({ ingest: false }),
        exportFn: async () => ({ rowCount: 0, parquetPath: "x.parquet" }),
        buildFn: async () => ({ distDir: "dist", files: [] }),
        rindexerBin: "rindexer",
        rpcClient: mockRpc(200),
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });

    const cancelled = runsCancel(cwd, plan.plan_id!);
    expect(cancelled.ok).toBe(true);
    expect((cancelled.data as { was: string }).was).toBe("running");
    const list = await runCliJson(["runs", "list", "--json"], cwd);
    expect(
      (list.data as { runs: { status: string }[] }).runs.map((r) => r.status),
    ).toContain("canceled");
  });

  // The cooperative half: a flag is only a cancellation if apply honours it.
  it("apply stops before doing any work and records the run as canceled", async () => {
    const cwd = setupProject();
    const { plan, planPath } = await generatePlan({
      intent: "ingest",
      cwd,
      project: project(cwd),
      rpcClient: mockRpc(200),
    });

    // The key is the plan id, so cancellation can be requested before apply.
    writeJournalStatus(cwd, plan.plan_id!, {
      status: "running",
      plan_id: plan.plan_id!,
      plan_digest: plan.project_digest,
    });
    expect(runsCancel(cwd, plan.plan_id!).ok).toBe(true);

    const reached = { ingest: false };
    await expect(
      applyPlan({
        cwd,
        planRef: planPath,
        adapter: adapter(reached),
        exportFn: async () => ({ rowCount: 0, parquetPath: "x.parquet" }),
        buildFn: async () => ({ distDir: "dist", files: [] }),
        rindexerBin: "rindexer",
        rpcClient: mockRpc(200),
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });

    // No ingest ran, and the journal says canceled rather than failed.
    expect(reached.ingest).toBe(false);
    const list = await runCliJson(["runs", "list", "--json"], cwd);
    const runs = (list.data as { runs: { status: string }[] }).runs;
    expect(runs.map((r) => r.status)).toContain("canceled");
  });
});
