import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliJson } from "../helpers/run.js";
import { projectIdFrom } from "../../src/cli/commands/init.js";

describe("init", () => {
  it("lists fixture-transfers", async () => {
    const result = await runCliJson(["templates", "list", "--json"], process.cwd());
    expect(result.ok).toBe(true);
    const ids = (result.data as { templates: { id: string }[] }).templates.map((t) => t.id);
    expect(ids).toContain("fixture-transfers");
  });

  it("creates a project and fails on collision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-init-"));
    const first = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", dir, "--json"],
      process.cwd(),
    );
    expect(first.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "chainplot.yaml"))).toBe(true);
    const second = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", dir, "--json"],
      process.cwd(),
    );
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("validation");
  });
});

describe("project id from the output directory", () => {
  it("keeps what a project id may carry and folds the rest to a dash", () => {
    expect(projectIdFrom("my-analytics")).toBe("my-analytics");
    expect(projectIdFrom("My Project!")).toBe("My-Project");
    expect(projectIdFrom("v1.2_data")).toBe("v1.2_data");
    expect(projectIdFrom("...")).toBeNull();
  });

  it("falls back to the template id when the directory name is unusable", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-init-id-"));
    const out = path.join(parent, "!!!");
    const result = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", out, "--json"],
      parent,
    );
    expect(result.ok).toBe(true);
    expect((result.data as { id: string }).id).toBe("fixture-transfers");
  });
});
