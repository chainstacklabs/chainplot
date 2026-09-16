import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

function setup(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-modes-"));
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}

async function makeBigParquet(dir: string): Promise<void> {
  const big = path.join(dir, "snapshots/amounts.parquet");
  fs.mkdirSync(path.dirname(big), { recursive: true });
  // Valid parquet > 100 MiB: random strings compress poorly.
  const { execFileSync } = await import("node:child_process");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DuckDBInstance } from '@duckdb/node-api';
       const db = await DuckDBInstance.create(':memory:');
       const c = await db.connect();
       await c.run("COPY (SELECT i AS amount, md5(i::VARCHAR) AS amount_sort FROM range(3200000) t(i)) TO '${big.replace(/'/g, "''")}' (FORMAT PARQUET)");`,
    ],
    { stdio: "pipe" },
  );
  // Aggregate query so the row limit does not trip before the size cap.
  fs.writeFileSync(path.join(dir, "queries/raw_amounts.sql"), "select count(*) as n from amounts");
}

describe("dataset modes and size caps", () => {
  // Publishing is outward and irreversible, so the default ships the page and
  // its answers and leaves the dataset behind. Shipping the parquet is what
  // lets a fork recompute, and it is opt-in.
  it("default omits the dataset", async () => {
    const dir = setup();
    const result = await runCliJson(["build", "--json"], dir);
    expect(result.ok).toBe(true);
    const dist = path.join(dir, "dist/releases/local");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dist, "datasets/amounts/manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("results_only");
    expect(fs.existsSync(path.join(dist, "datasets/amounts/tables"))).toBe(false);
    // The page and its answers are still whole.
    expect(fs.existsSync(path.join(dist, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(dist, "results/raw_amounts.json"))).toBe(true);
  });

  it("--mode dataset_included ships the parquet", async () => {
    const dir = setup();
    const result = await runCliJson(
      ["build", "--mode", "dataset_included", "--json"],
      dir,
    );
    expect(result.ok).toBe(true);
    const dist = path.join(dir, "dist/releases/local");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dist, "datasets/amounts/manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("dataset_included");
    expect(
      fs.existsSync(path.join(dist, "datasets/amounts/tables/amounts.parquet")),
    ).toBe(true);
  });

  it("an oversized dataset is refused only when it was asked for", async () => {
    const dir = setup();
    await makeBigParquet(dir);
    // The default no longer trips the cap at all: nothing is copied.
    expect((await runCliJson(["build", "--json"], dir)).ok).toBe(true);

    const result = await runCliJson(
      ["build", "--mode", "dataset_included", "--json"],
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
    expect(result.error?.message).toMatch(/results_only|dataset_referenced|reduce/i);
  });

  it("build --mode results_only omits tables", async () => {
    const dir = setup();
    await makeBigParquet(dir);
    const result = await runCliJson(["build", "--mode", "results_only", "--json"], dir);
    expect(result.ok).toBe(true);
    const dist = path.join(dir, "dist/releases/local");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dist, "datasets/amounts/manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("results_only");
    expect(fs.existsSync(path.join(dist, "datasets/amounts/tables"))).toBe(false);
    const release = JSON.parse(
      fs.readFileSync(path.join(dist, "release.json"), "utf8"),
    );
    expect(release.mode).toBe("results_only");
  });

  it("build --mode dataset_referenced writes a pointer manifest", async () => {
    const dir = setup();
    const result = await runCliJson(["build", "--mode", "dataset_referenced", "--json"], dir);
    expect(result.ok).toBe(true);
    const dist = path.join(dir, "dist/releases/local");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dist, "datasets/amounts/manifest.json"), "utf8"),
    );
    expect(manifest.mode).toBe("dataset_referenced");
    expect(fs.existsSync(path.join(dist, "datasets/amounts/tables"))).toBe(false);
    const expectedChecksum = createHash("sha256")
      .update(fs.readFileSync(path.join(dir, "snapshots/amounts.parquet")))
      .digest("hex");
    expect(manifest.external.checksum).toBe(expectedChecksum);
  });
});

// `apply` and `refresh` build with no way to pass --mode, so a project whose
// dataset exceeds the copy cap could never finish either: the ingest
// succeeded and the build was refused every time, with nowhere to say
// otherwise.
describe("project-declared release mode", () => {
  it("uses policy.release_mode when the CLI passes no mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-relmode-"));
    fs.cpSync(template, dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "chainplot.yaml"),
      `${fs.readFileSync(path.join(dir, "chainplot.yaml"), "utf8")}
policy:
  release_mode: results_only
`,
    );

    const built = await runCliJson(["build", "--json"], dir);
    expect(built.ok).toBe(true);
    const release = JSON.parse(
      fs.readFileSync(path.join(dir, "dist/releases/local/release.json"), "utf8"),
    ) as { mode: string };
    expect(release.mode).toBe("results_only");
    expect(
      fs.existsSync(path.join(dir, "dist/releases/local/datasets/amounts/tables")),
    ).toBe(false);
  });

  it("an explicit --mode still wins over the project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-relmode2-"));
    fs.cpSync(template, dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "chainplot.yaml"),
      `${fs.readFileSync(path.join(dir, "chainplot.yaml"), "utf8")}
policy:
  release_mode: results_only
`,
    );

    const built = await runCliJson(
      ["build", "--mode", "dataset_included", "--json"],
      dir,
    );
    expect(built.ok).toBe(true);
    const release = JSON.parse(
      fs.readFileSync(path.join(dir, "dist/releases/local/release.json"), "utf8"),
    ) as { mode: string };
    expect(release.mode).toBe("dataset_included");
  });
});

// The row limit bounds the viewer, which renders every row into the DOM. The
// value lived as four separate copies of 10_000 with nothing keeping them in
// step, and no project could raise it — so a legitimate wide table was simply
// impossible to publish.
describe("row limit", () => {
  it("is refused, not truncated, and the project can raise it", async () => {
    const dir = setup();
    fs.writeFileSync(
      path.join(dir, "queries/raw_amounts.sql"),
      "SELECT i::VARCHAR AS n FROM range(25) t(i)",
    );
    const yaml = fs.readFileSync(path.join(dir, "chainplot.yaml"), "utf8");

    fs.writeFileSync(
      path.join(dir, "chainplot.yaml"),
      `${yaml}\npolicy:\n  row_limit: 10\n`,
    );
    const refused = await runCliJson(["build", "--json"], dir);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("policy_refused");
    expect(refused.error?.message).toMatch(/more than 10 rows/);

    fs.writeFileSync(
      path.join(dir, "chainplot.yaml"),
      `${yaml}\npolicy:\n  row_limit: 100\n`,
    );
    const allowed = await runCliJson(["build", "--json"], dir);
    expect(allowed.ok).toBe(true);
    const result = JSON.parse(
      fs.readFileSync(
        path.join(dir, "dist/releases/local/results/raw_amounts.json"),
        "utf8",
      ),
    ) as { rows: unknown[][] };
    expect(result.rows).toHaveLength(25);
  });
});
