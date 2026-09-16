import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliJson } from "../helpers/run.js";

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
