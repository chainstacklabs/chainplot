import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

const TARGETS = [
  "publish_targets:",
  "  - id: local-dir",
  "    type: directory",
  "    path: ./published",
  "    dataset_license: CC-BY-4.0",
].join("\n");

function setupProject(withLicense = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-publish-"));
  fs.cpSync(template, dir, { recursive: true });
  const yaml = fs.readFileSync(path.join(dir, "chainplot.yaml"), "utf8");
  fs.writeFileSync(
    path.join(dir, "chainplot.yaml"),
    yaml + "\n" + (withLicense ? TARGETS : TARGETS.replace("    dataset_license: CC-BY-4.0", "")) + "\n",
  );
  return dir;
}

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = { RPC_URL: process.env.RPC_URL, DATABASE_URL: process.env.DATABASE_URL };
  delete process.env.RPC_URL;
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("publish", () => {
  it("build + publish writes the release and latest.json under the target", async () => {
    const dir = setupProject();
    expect((await runCliJson(["build", "--json"], dir)).ok).toBe(true);
    const result = await runCliJson(["publish", "--json"], dir);
    expect(result.ok).toBe(true);
    const targetRoot = path.join(dir, "published");
    expect(fs.existsSync(path.join(targetRoot, "latest.json"))).toBe(true);
    const pointer = JSON.parse(
      fs.readFileSync(path.join(targetRoot, "latest.json"), "utf8"),
    );
    expect(pointer.release_prefix).toMatch(/^releases\//);
    expect(
      fs.existsSync(
        path.join(targetRoot, pointer.release_prefix, "release.json"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(targetRoot, "releases/local/release.json")),
    ).toBe(false);
  }, 30_000);

  it("missing dataset_license → policy_refused", async () => {
    const dir = setupProject(false);
    await runCliJson(["build", "--json"], dir);
    const result = await runCliJson(["publish", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
    expect(result.error?.message).toMatch(/dataset_license/);
  });

  it("publish without a prior build → validation", async () => {
    const dir = setupProject();
    const result = await runCliJson(["publish", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toMatch(/build/i);
  });

  it("unknown --publish-target → policy_refused", async () => {
    const dir = setupProject();
    await runCliJson(["build", "--json"], dir);
    const result = await runCliJson(
      ["publish", "--publish-target", "nope", "--json"],
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
  });

  it("plan --intent publish makes no RPC and is digest-bound", async () => {
    const dir = setupProject();
    await runCliJson(["build", "--json"], dir);
    const plan = await runCliJson(["plan", "--intent", "publish", "--json"], dir);
    expect(plan.ok).toBe(true);
    expect((plan.data as { actions: { type: string }[] }).actions).toEqual([
      { type: "publish", target_id: "local-dir" },
    ]);
    // apply the plan → published
    const planPath = (plan.data as { plan_path: string }).plan_path;
    const applied = await runCliJson(["apply", "--plan", planPath, "--json"], dir);
    expect(applied.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "published/latest.json"))).toBe(true);
  });
});

// The publish plan digest once covered only the project files, so rebuilding a
// release with different content produced an identical plan: `apply` reused the
// previous run and uploaded nothing, while still reporting files_uploaded and
// promoted from the cached result. Binding the plan to the release's
// content_digest is what makes a changed release a different plan.
describe("publish plan binds to release content", () => {
  it("re-publishes after the built release changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-repub-"));
    fs.cpSync(template, dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "chainplot.yaml"),
      `publish_targets:
  - id: local-dir
    type: directory
    path: ./published
    dataset_license: CC-BY-4.0
`,
    );

    expect((await runCliJson(["build", "--json"], dir)).ok).toBe(true);
    const first = await runCliJson(["publish", "--json"], dir);
    expect(first.ok).toBe(true);

    // Same bytes: reuse is correct, and the prefix must not move.
    expect((await runCliJson(["build", "--json"], dir)).ok).toBe(true);
    const again = await runCliJson(["publish", "--json"], dir);
    const firstPrefix = (first.data as PublishEnvelope).publish.release_prefix;
    expect((again.data as PublishEnvelope).publish.release_prefix).toBe(firstPrefix);

    // Different bytes: a new release must actually be uploaded.
    fs.writeFileSync(
      path.join(dir, "queries", "raw_amounts.sql"),
      "SELECT amount FROM amounts ORDER BY cp_sortkey(amount) DESC",
    );
    expect((await runCliJson(["build", "--json"], dir)).ok).toBe(true);
    const third = await runCliJson(["publish", "--json"], dir);
    expect(third.ok).toBe(true);
    const thirdData = third.data as PublishEnvelope;
    expect(thirdData.reused).toBe(false);
    expect(thirdData.publish.release_prefix).not.toBe(firstPrefix);
    expect(
      fs.existsSync(
        path.join(dir, "published", thirdData.publish.release_prefix, "release.json"),
      ),
    ).toBe(true);
  });
});

interface PublishEnvelope {
  reused: boolean;
  publish: { release_prefix: string };
}
