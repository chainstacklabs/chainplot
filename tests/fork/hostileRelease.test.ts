import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

// A12, the honest version: a fork imports a stranger's recipe and the next
// `build` executes it. These publish a release whose SQL attacks the host,
// fork it, and build — the whole path an attacker actually has.

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

interface Hostile {
  published: string;
  canary: string;
}

/** Publish a release whose recipe carries `modelSql` as a model. */
async function publishHostileRelease(modelSql: string): Promise<Hostile> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-hostile-"));
  const project = path.join(parent, "proj");
  fs.cpSync(template, project, { recursive: true });

  const canary = path.join(parent, "victim-secret.txt");
  fs.writeFileSync(canary, "AWS_SECRET_ACCESS_KEY=canary");

  fs.mkdirSync(path.join(project, "models"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "models", "exfil.sql"),
    modelSql.replace("__CANARY__", canary),
  );
  fs.writeFileSync(path.join(project, "queries", "exfil.sql"), "SELECT * FROM exfil");
  fs.writeFileSync(
    path.join(project, "chainplot.yaml"),
    `format_version: 1
id: fixture-transfers
datasets:
  - id: amounts
    snapshot: snapshots/amounts.parquet
models:
  - id: exfil
    file: models/exfil.sql
    depends_on: []
queries:
  - id: exfil
    file: queries/exfil.sql
    dataset: amounts
dashboards:
  - id: overview
    title: Amounts
    panels:
      - query: exfil
        chart: table
publish_targets:
  - id: local-dir
    type: directory
    path: ./published
    dataset_license: CC-BY-4.0
`,
  );

  // The hostile project must not be buildable either — the publisher is
  // running the same engine. Build it with the model neutralised so there is
  // a release to fork, then swap the hostile model into the published bundle.
  const benign = path.join(project, "models", "exfil.sql");
  const hostileSql = fs.readFileSync(benign, "utf8");
  fs.writeFileSync(benign, "SELECT amount AS leaked FROM amounts");
  expect(
    (await runCliJson(["build", "--mode", "dataset_included", "--json"], project)).ok,
  ).toBe(true);
  expect((await runCliJson(["publish", "--json"], project)).ok).toBe(true);

  // Rewrite the published recipe and its checksum, exactly as whoever
  // controls the bucket could.
  const published = path.join(project, "published");
  const pointer = JSON.parse(
    fs.readFileSync(path.join(published, "latest.json"), "utf8"),
  ) as { release_prefix: string };
  const releaseDir = path.join(published, pointer.release_prefix);
  const modelPath = path.join(releaseDir, "source", "models", "exfil.sql");
  fs.writeFileSync(modelPath, hostileSql);

  const { createHash } = await import("node:crypto");
  const releaseJsonPath = path.join(releaseDir, "release.json");
  const release = JSON.parse(fs.readFileSync(releaseJsonPath, "utf8")) as {
    files: { path: string; checksum: string }[];
  };
  for (const file of release.files) {
    if (file.path === "source/models/exfil.sql") {
      file.checksum = createHash("sha256").update(hostileSql).digest("hex");
    }
  }
  fs.writeFileSync(releaseJsonPath, `${JSON.stringify(release, null, 2)}\n`);
  const body = fs.readFileSync(releaseJsonPath, "utf8");
  fs.writeFileSync(
    path.join(published, "latest.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        release_prefix: pointer.release_prefix,
        release_json_checksum: createHash("sha256").update(body).digest("hex"),
      },
      null,
      2,
    )}\n`,
  );

  return { published, canary };
}

async function forkAndBuild(published: string): Promise<{
  ok: boolean;
  code: string | null;
  out: string;
}> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-victim-"));
  const out = path.join(parent, "forked");
  const fork = await runCliJson(
    ["fork", "--from", published, "--output", out, "--json"],
    parent,
  );
  expect(fork.ok).toBe(true);
  const build = await runCliJson(["build", "--json"], out);
  return { ok: build.ok, code: build.error?.code ?? null, out };
}

describe("forking a hostile release (A12)", () => {
  it("a model cannot read the victim's filesystem", async () => {
    const { published, canary } = await publishHostileRelease(
      "SELECT content AS leaked FROM read_text('__CANARY__')",
    );
    const { ok, out } = await forkAndBuild(published);

    expect(ok).toBe(false);
    const leaked = path.join(out, "dist", "releases", "local", "results", "exfil.json");
    expect(fs.existsSync(leaked)).toBe(false);
    // Belt and braces: nothing anywhere in the forked build echoes the secret.
    expect(fs.readFileSync(canary, "utf8")).toContain("canary");
    const dist = path.join(out, "dist");
    const found = fs.existsSync(dist)
      ? fs
          .readdirSync(dist, { recursive: true, encoding: "utf8" })
          .some((entry) => entry.includes("exfil.json"))
      : false;
    expect(found).toBe(false);
  });

  // Belt and braces: httpfs cannot autoload either, so this is refused twice
  // over. The filesystem case above is the one that pins the access flag.
  it("a model cannot reach the network", async () => {
    const { published } = await publishHostileRelease(
      "SELECT * FROM read_csv('https://example.invalid/steal.csv')",
    );
    expect((await forkAndBuild(published)).ok).toBe(false);
  });

  it("a non-SELECT model is refused as policy", async () => {
    const { published } = await publishHostileRelease(
      "CREATE TABLE pwned AS SELECT 1",
    );
    expect((await forkAndBuild(published)).code).toBe("policy_refused");
  });
});
