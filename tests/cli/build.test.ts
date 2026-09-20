import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("build", () => {
  it("writes the full static release layout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-build-"));
    fs.cpSync(template, dir, { recursive: true });

    const result = await runCliJson(
      ["build", "--mode", "dataset_included", "--json"],
      dir,
    );
    expect(result.ok).toBe(true);
    const dist = path.join(dir, "dist/releases/local");
    for (const rel of [
      "release.json",
      "index.html",
      "results/raw_amounts.json",
      "dashboards/overview.json",
      "datasets/amounts/manifest.json",
      "datasets/amounts/tables/amounts.parquet",
      "source/chainplot.yaml",
      "source/queries/raw_amounts.sql",
    ]) {
      expect(fs.existsSync(path.join(dist, rel))).toBe(true);
    }
    expect(fs.existsSync(path.join(dist, "assets"))).toBe(true);

    const release = JSON.parse(
      fs.readFileSync(path.join(dist, "release.json"), "utf8"),
    );
    expect(release).toMatchObject({
      schema_version: 1,
      project_id: "fixture-transfers",
      mode: "dataset_included",
      queries: ["raw_amounts"],
      dashboards: ["overview"],
    });
    expect(typeof release.generated_at).toBe("string");

    const dash = JSON.parse(
      fs.readFileSync(path.join(dist, "dashboards/overview.json"), "utf8"),
    );
    expect(dash.title).toBe("Amounts");

    const raw = JSON.parse(
      fs.readFileSync(path.join(dist, "results/raw_amounts.json"), "utf8"),
    );
    expect(typeof raw.rows[0][0]).toBe("string");
    expect(raw.raw_amount_columns).toEqual(["amount"]);
    expect(typeof raw.query_digest).toBe("string");

    // source/ allowlist: no secrets, no work dirs
    expect(fs.existsSync(path.join(dist, "source/.env"))).toBe(false);
    expect(fs.existsSync(path.join(dist, "source/.chainplot"))).toBe(false);
  });
});

// Models are materialized into every query's session. While each session
// loaded only that query's own dataset, a model over dataset A failed every
// query on dataset B and took the whole build with it — which made `models`
// unusable in any project with more than one dataset, i.e. every real one.
describe("multi-dataset projects", () => {
  it("materializes models and joins across datasets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-multi-"));
    fs.mkdirSync(path.join(dir, "queries"), { recursive: true });
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });

    const fixture = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../templates/fixture-transfers/snapshots/amounts.parquet",
    );
    fs.copyFileSync(fixture, path.join(dir, "snapshots/a.parquet"));
    fs.copyFileSync(fixture, path.join(dir, "snapshots/b.parquet"));

    fs.writeFileSync(
      path.join(dir, "models/a_rollup.sql"),
      "SELECT count(*) AS n FROM a",
    );
    fs.writeFileSync(path.join(dir, "queries/from_a.sql"), "SELECT n FROM a_rollup");
    fs.writeFileSync(
      path.join(dir, "queries/joined.sql"),
      "SELECT ((SELECT count(*) FROM a) + (SELECT count(*) FROM b))::VARCHAR AS total",
    );
    fs.writeFileSync(
      path.join(dir, "chainplot.yaml"),
      `format_version: 1
id: multi
datasets:
  - id: a
    snapshot: snapshots/a.parquet
  - id: b
    snapshot: snapshots/b.parquet
models:
  - id: a_rollup
    file: models/a_rollup.sql
    depends_on: []
queries:
  - id: from_a
    file: queries/from_a.sql
    dataset: a
  - id: joined
    file: queries/joined.sql
    dataset: b
dashboards:
  - id: d
    title: D
    panels:
      - query: from_a
        chart: kpi
`,
    );

    const built = await runCliJson(["build", "--json"], dir);
    expect(built.ok).toBe(true);

    const joined = JSON.parse(
      fs.readFileSync(
        path.join(dir, "dist/releases/local/results/joined.json"),
        "utf8",
      ),
    ) as { rows: string[][] };
    // Both fixtures have 8 rows, so a real cross-dataset join yields 16.
    expect(joined.rows[0]?.[0]).toBe("16");
  });
});
