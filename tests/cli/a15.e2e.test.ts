import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("A15", () => {
  it("init, validate, test, build with network disabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-a15-"));
    const env = {
      ...process.env,
      NO_NETWORK: "1",
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    // Compiled entry: pnpm exec tsx fails when cwd is the init output (no package.json).
    const bin = path.resolve("dist/cli/main.js");
    expect(fs.existsSync(bin)).toBe(true);
    const run = (args: string[], cwd: string) =>
      spawnSync(process.execPath, [bin, ...args, "--json"], {
        cwd,
        env,
        encoding: "utf8",
      });
    const init = run(
      ["init", "--template", "fixture-transfers", "--output", dir],
      process.cwd(),
    );
    expect(init.status).toBe(0);
    for (const cmd of [["validate"], ["test"], ["build"]]) {
      const r = run(cmd, dir);
      expect(r.status, r.stderr).toBe(0);
      const json = JSON.parse(r.stdout);
      expect(json.ok).toBe(true);
      expect(json.schema_version).toBe(1);
    }
  }, 30_000);
});
