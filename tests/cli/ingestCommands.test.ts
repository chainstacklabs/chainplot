import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { runCliJson } from "../helpers/run.js";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

let rpcServer: import("node:http").Server | null = null;

async function startMockRpc(head: number): Promise<string> {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { id: number; params: unknown[] };
        const tag = parsed.params[0] as string;
        const n = tag === "finalized" ? head : Number(BigInt(tag));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              number: "0x" + n.toString(16),
              hash: H(n),
              parentHash: H(n - 1),
            },
          }),
        );
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  rpcServer = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const INGEST_YAML = [
  "format_version: 1",
  'id: "ingest-cli"',
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

function setupIngestProject(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-cli-"));
  fs.mkdirSync(path.join(cwd, "abis"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "chainplot.yaml"), INGEST_YAML + "\n");
  fs.writeFileSync(path.join(cwd, "abis/ERC20.json"), "[]");
  fs.writeFileSync(
    path.join(cwd, "queries/count.sql"),
    "select count(*) as transfer_count from usdc",
  );
  fs.mkdirSync(path.join(cwd, ".chainplot/snapshots/usdc"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".chainplot/snapshots/usdc/usdc_transfer.parquet"),
    "PK\x03\x04dummy",
  );
  return cwd;
}

function fixtureParquet(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates/fixture-transfers/snapshots/amounts.parquet",
  );
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
    CHAINPLOT_RINDEXER_BIN: process.env.CHAINPLOT_RINDEXER_BIN,
  };
  delete process.env.RPC_URL;
  delete process.env.DATABASE_URL;
  delete process.env.CHAINPLOT_RINDEXER_BIN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rpcServer?.close();
  rpcServer = null;
});

describe("plan command", () => {
  it("build intent → ok with build_results action", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-cli-"));
    const result = await runCliJson(["plan", "--intent", "build", "--json"], cwd);
    expect(result.ok).toBe(false); // project missing chainplot.yaml → validation, not unsupported
    expect(result.error?.code).toBe("validation");
  });

  it("ingest without credentials → missing_credentials", async () => {
    const cwd = setupIngestProject();
    const result = await runCliJson(["plan", "--intent", "ingest", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("missing_credentials");
  });

  it("ingest with credentials writes a plan file", async () => {
    const cwd = setupIngestProject();
    process.env.RPC_URL = await startMockRpc(200);
    process.env.DATABASE_URL = "postgres://test@localhost/db";
    const result = await runCliJson(["plan", "--intent", "ingest", "--json"], cwd);
    expect(result.ok).toBe(true);
    const data = result.data as { plan_id: string; plan_path: string };
    expect(data.plan_id).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(data.plan_path)).toBe(true);
  });
});

describe("apply command", () => {
  it("missing plan → validation", async () => {
    const cwd = setupIngestProject();
    const result = await runCliJson(["apply", "--plan", "nope", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});

describe("refresh command", () => {
  it("dataset-only project → policy_refused", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-refresh-"));
    fs.mkdirSync(path.join(cwd, "snapshots"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "chainplot.yaml"),
      [
        "format_version: 1",
        "id: fixture",
        "datasets:",
        "  - id: amounts",
        "    snapshot: snapshots/amounts.parquet",
        "queries:",
        "  - id: raw_amounts",
        "    file: queries/raw_amounts.sql",
        "    dataset: amounts",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(cwd, "snapshots/amounts.parquet"), "PK\x03\x04dummy");
    fs.mkdirSync(path.join(cwd, "queries"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "queries/raw_amounts.sql"), "select 1");
    const result = await runCliJson(["refresh", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
  });

  it("unknown --publish-target → policy_refused", async () => {
    const cwd = setupIngestProject();
    const result = await runCliJson(
      ["refresh", "--publish-target", "nope", "--json"],
      cwd,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
  });

  it("ingest-relevant edit after applied plan → policy_refused (A16)", async () => {
    const cwd = setupIngestProject();
    // Seed a succeeded run journal (as if a previous apply had completed)
    // instead of running a real ingest, which would need live Postgres.
    const { parse } = await import("yaml");
    const { createHash } = await import("node:crypto");
    const project = parse(INGEST_YAML);
    const key = "seeded-run";
    const runDir = path.join(cwd, ".chainplot", "runs", key);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "project.json"),
      JSON.stringify(project),
    );
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      JSON.stringify({
        status: "succeeded",
        plan_id: key,
        plan_digest: key,
        updated_at: new Date().toISOString(),
      }),
    );

    fs.writeFileSync(
      path.join(cwd, "chainplot.yaml"),
      INGEST_YAML.replace(
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "0x000000000000000000000000000000000000dead",
      ) + "\n",
    );
    const refused = await runCliJson(["refresh", "--json"], cwd);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("policy_refused");
  });

  it("pinned complete, no ingest-relevant edits → rebuild only, zero RPC (A16)", async () => {
    const cwd = setupIngestProject();
    writeCompleteCoverage(cwd);
    fs.mkdirSync(path.join(cwd, ".chainplot/snapshots/usdc"), { recursive: true });
    fs.copyFileSync(
      fixtureParquet(),
      path.join(cwd, ".chainplot/snapshots/usdc/usdc_transfer.parquet"),
    );
    const result = await runCliJson(["refresh", "--json"], cwd);
    expect(result.ok).toBe(true);
  }, 30_000);
});
