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

describe("A10: second agent forks published data", () => {
  it("new query + dashboard over the forked snapshot, no RPC/Postgres/credentials", async () => {
    // Producer: build + publish a directory release.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-a10-"));
    const producer = path.join(parent, "producer");
    fs.cpSync(template, producer, { recursive: true });
    fs.writeFileSync(
      path.join(producer, "chainplot.yaml"),
      `${fs.readFileSync(path.join(producer, "chainplot.yaml"), "utf8")}
publish_targets:
  - id: local-dir
    type: directory
    path: ./published
    dataset_license: CC-BY-4.0
`,
    );
    // Shipping the dataset is opt-in; A10 is precisely the case that wants it.
    expect(
      (await runCliJson(["build", "--mode", "dataset_included", "--json"], producer)).ok,
    ).toBe(true);
    expect((await runCliJson(["publish", "--json"], producer)).ok).toBe(true);

    // Second agent: fork, write a NEW query + dashboard, build.
    const forked = path.join(parent, "forked");
    const fork = await runCliJson(
      ["fork", "--from", path.join(producer, "published"), "--output", forked, "--json"],
      parent,
    );
    expect(fork.ok).toBe(true);

    fs.mkdirSync(path.join(forked, "queries"), { recursive: true });
    fs.writeFileSync(
      path.join(forked, "queries/max_amount.sql"),
      "select max(amount) as max_amount from amounts",
    );
    const yamlPath = path.join(forked, "chainplot.yaml");
    const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
    const doc = parseYaml(fs.readFileSync(yamlPath, "utf8")) as {
      queries: { id: string; file: string; dataset: string }[];
      dashboards: { id: string; title: string; panels: { query: string; chart: string }[] }[];
    };
    doc.queries.push({
      id: "max_amount",
      file: "queries/max_amount.sql",
      dataset: "amounts",
    });
    doc.dashboards.push({
      id: "second-agent",
      title: "Second agent view",
      panels: [{ query: "max_amount", chart: "kpi" }],
    });
    fs.writeFileSync(yamlPath, stringifyYaml(doc));

    // No network, no credentials: validate + build must succeed offline.
    delete process.env.RPC_URL;
    delete process.env.DATABASE_URL;
    expect((await runCliJson(["validate", "--json"], forked)).ok).toBe(true);
    const built = await runCliJson(["build", "--json"], forked);
    expect(built.ok).toBe(true);
    const results = JSON.parse(
      fs.readFileSync(
        path.join(forked, "dist/releases/local/results/max_amount.json"),
        "utf8",
      ),
    );
    expect(results.rows.length).toBeGreaterThan(0);
  }, 30_000);
});
