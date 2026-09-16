import { describe, expect, it, afterEach } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../../../src/config/env.js";

const exec = promisify(execFile);

// Live-gated on the two things that genuinely cannot be provisioned here: an
// archive-capable RPC_URL, and Docker. Postgres and the pinned rindexer binary
// both come from the template's own compose.yaml, so there is nothing else to
// install or point an env var at.
//
// Everything runs inside the producer container, which is where rindexer lives
// (it is linux/amd64-only and never on the host PATH). That also makes this the
// same path a user follows from the template README.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

// Load the repo-root .env explicitly rather than relying on another helper's
// import side effect.
loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));

const rpcUrl = process.env.RPC_URL;
const IMAGE = process.env.CHAINPLOT_IMAGE ?? "chainplot:local";

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["info"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();
const d = rpcUrl && hasDocker ? it : it.skip;

async function compose(cwd: string, args: string[], timeout = 900_000) {
  return exec("docker", ["compose", ...args], {
    cwd,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CHAINPLOT_IMAGE: IMAGE },
  });
}

/** Run the CLI inside the producer container and parse its envelope. */
async function cli(cwd: string, args: string[]): Promise<{
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}> {
  // The same invocation the template README documents. The CLI exits non-zero
  // on a refusal, which is a result here rather than a failure, so the envelope
  // is read either way.
  let stdout: string;
  try {
    ({ stdout } = await compose(cwd, [
      "exec",
      "-T",
      "producer",
      "chainplot",
      ...args,
      "--json",
    ]));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? "";
    if (!stdout.trim()) throw err;
  }
  const last = stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(last) as {
    ok: boolean;
    data: unknown;
    error: { code: string; message: string } | null;
  };
}

describe("live ingest end-to-end (M0 replay through the product)", () => {
  let cwd = "";

  afterEach(async () => {
    if (!cwd) return;
    await compose(cwd, ["down", "-v"], 120_000).catch(() => undefined);
    cwd = "";
  });

  d(
    "plan → apply → coverage → idempotent re-apply → no-op plan → gate",
    async () => {
      // The producer image is the CLI plus rindexer, built from this repo.
      // rindexer ships linux/amd64 only, so the whole image must be that
      // platform; an arm64 host builds it under emulation.
      await exec(
        "docker",
        [
          "build",
          "--platform",
          "linux/amd64",
          "-t",
          IMAGE,
          "-f",
          path.join(repoRoot, "docker/producer.Dockerfile"),
          repoRoot,
        ],
        { timeout: 900_000, maxBuffer: 32 * 1024 * 1024 },
      );

      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-live-"));
      cwd = path.join(parent, "proj");
      const init = await exec("node", [
        path.join(repoRoot, "dist/cli/main.js"),
        "init",
        "--template",
        "ingest-transfers",
        "--output",
        cwd,
        "--json",
      ]);
      expect(JSON.parse(init.stdout.trim()).ok).toBe(true);

      // The only secret the project needs; Postgres comes from compose.
      fs.writeFileSync(
        path.join(cwd, ".env"),
        `RPC_URL=${rpcUrl}\nDATABASE_URL=postgresql://chainplot:chainplot@postgres:5432/chainplot\n`,
      );
      await compose(cwd, ["up", "-d"]);

      const plan = await cli(cwd, ["plan", "--intent", "ingest"]);
      expect(plan.ok).toBe(true);
      const planData = plan.data as {
        plan_path: string;
        sources: { job_start: number; job_end: number }[];
      };
      expect(planData.sources[0]).toMatchObject({
        job_start: 18600000,
        job_end: 18600010,
      });

      const apply = await cli(cwd, ["apply", "--plan", planData.plan_path]);
      expect(apply.ok).toBe(true);
      expect((apply.data as { reused: boolean }).reused).toBe(false);

      const coverage = JSON.parse(
        fs.readFileSync(path.join(cwd, ".chainplot/coverage.json"), "utf8"),
      ) as {
        chain_id: number;
        sources: {
          segments: {
            start_block: number;
            end_block: number;
            status: string;
            row_count: number;
            end_block_timestamp?: number;
            indexed_at?: string;
          }[];
        }[];
      };
      expect(coverage.chain_id).toBe(1);
      expect(coverage.sources[0].segments).toHaveLength(1);
      const segment = coverage.sources[0].segments[0]!;
      expect(segment).toMatchObject({
        start_block: 18600000,
        end_block: 18600010,
        status: "complete_with_rows",
      });
      expect(segment.row_count).toBeGreaterThan(0);
      // Freshness has to come from the chain, not from a file's mtime.
      expect(segment.end_block_timestamp).toBeGreaterThan(0);
      expect(segment.indexed_at).toBeTruthy();

      // Re-apply same plan + key → reused, no duplicate rows (A5).
      const again = await cli(cwd, ["apply", "--plan", planData.plan_path]);
      expect(again.ok).toBe(true);
      expect((again.data as { reused: boolean }).reused).toBe(true);

      // Second plan → job_start > job_end → no-op, coverage unchanged.
      const plan2 = await cli(cwd, ["plan", "--intent", "ingest"]);
      expect(plan2.ok).toBe(true);
      const plan2Data = plan2.data as {
        sources: { job_start: number; job_end: number }[];
        actions: { type: string }[];
      };
      expect(plan2Data.sources[0].job_start).toBe(18600011);
      expect(plan2Data.sources[0].job_end).toBe(18600010);
      expect(plan2Data.actions.some((a) => a.type === "ingest")).toBe(false);

      // A build over proven coverage produces a release with chain freshness.
      const built = await cli(cwd, ["build"]);
      expect(built.ok).toBe(true);
      const release = JSON.parse(
        fs.readFileSync(
          path.join(cwd, "dist/releases/local/release.json"),
          "utf8",
        ),
      ) as { freshness: { kind: string; data_through: { block: number } } };
      expect(release.freshness.kind).toBe("chain");
      expect(release.freshness.data_through.block).toBe(18600010);

      // Truncation probe: drop coverage → build refuses (M2 gate).
      fs.rmSync(path.join(cwd, ".chainplot/coverage.json"));
      const refused = await cli(cwd, ["build"]);
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("policy_refused");
    },
    1_800_000,
  );
});
