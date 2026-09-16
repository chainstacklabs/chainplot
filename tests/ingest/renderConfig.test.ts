import { describe, expect, it } from "vitest";
import { renderConfig } from "../../src/ingest/rindexer/renderConfig.js";
import type { BoundedJob } from "../../src/ingest/adapter.js";

const job: BoundedJob = {
  sourceId: "usdc-transfers",
  contractName: "usdc",
  networkName: "chainplot_1",
  chainId: 1,
  addresses: [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0x000000000000000000000000000000000000dead",
  ],
  abiPath: "/proj/abis/ERC20.json",
  events: ["Transfer", "Approval"],
  jobStart: 18600000,
  jobEnd: 18600010,
  rpcUrl: "http://rpc.example",
  databaseUrl: "postgres://u:p@localhost:5432/chainplot",
  workDir: "/proj/.chainplot/ingest/usdc-transfers",
};

describe("renderConfig", () => {
  const yaml = renderConfig(job);

  it("sets no-code project type and single network", () => {
    expect(yaml).toContain("project_type: no-code");
    expect(yaml).toContain("name: chainplot_1");
    expect(yaml).toContain("chain_id: 1");
    expect(yaml).toContain("rpc: ${RPC_URL}");
    expect(yaml).toMatch(/^name: chainplot_chainplot_1$/m);
    expect(yaml.match(/networks:/g)?.length).toBe(1);
  });

  it("enables postgres storage, disables graphql", () => {
    expect(yaml).toContain("postgres:");
    expect(yaml).toContain("enabled: true");
    expect(yaml).toContain("graphql:");
    expect(yaml).toContain("enabled: false");
  });

  it("never contains forbidden surfaces", () => {
    expect(yaml).not.toMatch(/streams|chatbots|csv|docker/i);
    expect(yaml).not.toContain("docker.sock");
  });

  it("writes explicit bounded blocks and timestamp true", () => {
    expect(yaml).toContain("start_block: 18600000");
    expect(yaml).toContain("end_block: 18600010");
    expect(yaml).toContain("timestamp: true");
  });

  it("limits events to declared signatures and lowercases addresses", () => {
    expect(yaml).toContain("- Transfer");
    expect(yaml).toContain("- Approval");
    expect(yaml).toContain("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(yaml).toContain("0x000000000000000000000000000000000000dead");
  });

  it("does not leak the rpc url into the config", () => {
    expect(yaml).not.toContain("http://rpc.example");
  });

  it("is deterministic", () => {
    expect(renderConfig(job)).toBe(yaml);
  });
});
