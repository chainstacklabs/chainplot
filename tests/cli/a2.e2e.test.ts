import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";
import { startServe } from "../../src/publish/serve.js";
const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("A2: presentation rebuild only", () => {
  it("dashboard title change → build reflects it, no ingest, offline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-a2-"));
    fs.cpSync(template, dir, { recursive: true });

    const first = await runCliJson(["build", "--mode", "dataset_included", "--json"], dir);
    expect(first.ok).toBe(true);

    const yamlPath = path.join(dir, "chainplot.yaml");
    const before = fs.readFileSync(yamlPath, "utf8");
    fs.writeFileSync(yamlPath, before.replace("title: Amounts", "title: Amounts v2"));

    const second = await runCliJson(["build", "--mode", "dataset_included", "--json"], dir);
    expect(second.ok).toBe(true);

    const dash = JSON.parse(
      fs.readFileSync(
        path.join(dir, "dist/releases/local/dashboards/overview.json"),
        "utf8",
      ),
    );
    expect(dash.title).toBe("Amounts v2");
    // No ingest artifacts were touched: no .chainplot coverage/plans created.
    expect(fs.existsSync(path.join(dir, ".chainplot"))).toBe(false);
  });
});

describe("A9 groundwork: served release over plain HTTP", () => {
  it("release renders from index.html + release.json alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-a9-"));
    fs.cpSync(template, dir, { recursive: true });
    await runCliJson(["build", "--mode", "dataset_included", "--json"], dir);
    const dist = path.join(dir, "dist/releases/local");

    const server = startServe(dist, 0);
    try {
      await server.ready;
      const url = `http://127.0.0.1:${server.port}`;
      const index = await fetch(`${url}/`);
      expect(index.status).toBe(200);
      const html = await index.text();
      expect(html).toContain("assets/index");
      const assetMatch = html.match(/src="\.\/(assets\/[^"]+\.js)"/);
      expect(assetMatch).not.toBeNull();
      const asset = await fetch(`${url}/${assetMatch![1]}`);
      expect(asset.status).toBe(200);
      const release = await fetch(`${url}/release.json`);
      expect(
        ((await release.json()) as { mode: string }).mode,
      ).toBe("dataset_included");
    } finally {
      server.close();
    }
  });
});
