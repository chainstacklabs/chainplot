import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { runCliJson } from "../helpers/run.js";
import type { ProjectDocument } from "../../src/project/types.js";

// Every bug found while taking chainplot to real data had one signature: a
// shipped feature that no example or test ever exercised. This asserts the
// examples keep covering the surface, so a feature cannot quietly lose its
// only demonstration.

const examplesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples",
);

function exampleProjects(): { id: string; dir: string; doc: ProjectDocument }[] {
  return fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, dir: path.join(examplesDir, e.name) }))
    .filter(({ dir }) => fs.existsSync(path.join(dir, "chainplot.yaml")))
    .map(({ id, dir }) => ({
      id,
      dir,
      doc: parseYaml(
        fs.readFileSync(path.join(dir, "chainplot.yaml"), "utf8"),
      ) as ProjectDocument,
    }));
}

describe("examples", () => {
  const projects = exampleProjects();

  it("there are examples to check", () => {
    expect(projects.length).toBeGreaterThanOrEqual(3);
  });

  for (const { id, dir } of projects) {
    it(`${id} validates`, async () => {
      const result = await runCliJson(["validate", "--json"], dir);
      expect(result.ok).toBe(true);
    });
  }

  it("every chart kind is demonstrated somewhere", () => {
    const used = new Set(
      projects.flatMap((p) =>
        (p.doc.dashboards ?? []).flatMap((d) => d.panels.map((panel) => panel.chart)),
      ),
    );
    // The allowlist the schema publishes; if a kind is added, an example owes
    // it a panel, because nothing else renders one.
    for (const kind of ["line", "bar", "area", "kpi", "table"]) {
      expect(used, `no example uses chart: ${kind}`).toContain(kind);
    }
  });

  it("indexed filters are demonstrated", () => {
    const filtered = projects.filter((p) =>
      (p.doc.event_sources ?? []).some((s) => (s.indexed_filters ?? []).length > 0),
    );
    expect(filtered.length, "no example uses indexed_filters").toBeGreaterThan(0);
  });

  it("models are demonstrated, including across datasets", () => {
    const withModels = projects.filter((p) => (p.doc.models ?? []).length > 0);
    expect(withModels.length, "no example uses models").toBeGreaterThan(0);
    // A model is only interesting once more than one dataset is in scope,
    // which is the case that was broken.
    expect(
      withModels.some((p) => (p.doc.datasets ?? []).length > 1),
      "no example runs a model over a multi-dataset project",
    ).toBe(true);
  });

  it("every release mode is demonstrated", () => {
    const modes = projects.map((p) => p.doc.policy?.release_mode ?? "results_only");
    // Each mode makes a different trade between page weight and whether a fork
    // can recompute. A mode nobody demonstrates is a mode nobody exercises.
    for (const mode of ["results_only", "dataset_referenced", "dataset_included"]) {
      expect(modes, `no example uses release_mode: ${mode}`).toContain(mode);
    }
  });

  it("every query and model file an example names exists", () => {
    for (const { id, dir, doc } of projects) {
      for (const q of doc.queries ?? []) {
        expect(fs.existsSync(path.join(dir, q.file)), `${id}: ${q.file}`).toBe(true);
      }
      for (const m of doc.models ?? []) {
        expect(fs.existsSync(path.join(dir, m.file)), `${id}: ${m.file}`).toBe(true);
      }
    }
  });
});
