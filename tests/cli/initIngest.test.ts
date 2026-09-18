import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const repoCwd = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("ingest-transfers template", () => {
  it("templates list includes it with required inputs", async () => {
    const result = await runCliJson(["templates", "list", "--json"], repoCwd);
    expect(result.ok).toBe(true);
    const templates = (result.data as { templates: { id: string }[] }).templates;
    expect(templates.map((t) => t.id)).toContain("ingest-transfers");
  });

  it("init scaffolds a runnable compose project; validate passes offline", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-init-"));
    const out = path.join(parent, "my-analytics");
    const init = await runCliJson(
      ["init", "--template", "ingest-transfers", "--output", out, "--json"],
      parent,
    );
    expect(init.ok).toBe(true);
    for (const file of [
      "chainplot.yaml",
      "compose.yaml",
      ".env.example",
      "abis/ERC20.json",
      "queries/transfer_count.sql",
    ]) {
      expect(fs.existsSync(path.join(out, file))).toBe(true);
    }

    // The producer image is built from the chainplot repo, so the scaffold
    // must not carry a Dockerfile whose context it cannot supply: `docker
    // compose build` in a scaffolded project failed on the missing CLI sources.
    expect(fs.existsSync(path.join(out, "Dockerfile"))).toBe(false);
    const compose = fs.readFileSync(path.join(out, "compose.yaml"), "utf8");
    expect(compose).toMatch(/image: \$\{CHAINPLOT_IMAGE/);
    expect(compose).not.toMatch(/^\s*build:/m);
    // The image entrypoint is the CLI, so a bare `command:` would be parsed as
    // CLI arguments and the container would exit before anything could run.
    expect(compose).toMatch(/entrypoint: \["sleep"\]/);
    // No RPC_URL anywhere in the scaffold.
    const envExample = fs.readFileSync(path.join(out, ".env.example"), "utf8");
    expect(envExample).toContain("RPC_URL=");
    expect(envExample).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|postgres)/);

    // The scaffold tells the user to create .env with their RPC endpoint;
    // nothing else would stop that file being committed with the project.
    const gitignore = fs.readFileSync(path.join(out, ".gitignore"), "utf8");
    for (const entry of [".env", ".chainplot/", "dist/"]) {
      expect(gitignore.split("\n")).toContain(entry);
    }
    // The project is named after its directory, not after the template.
    expect((init.data as { id: string }).id).toBe("my-analytics");
    expect(fs.readFileSync(path.join(out, "chainplot.yaml"), "utf8")).toMatch(
      /^id: "my-analytics"$/m,
    );

    const validated = await runCliJson(["validate", "--json"], out);
    expect(validated.ok).toBe(true);
  });

  it("init refuses collisions", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-init-"));
    const out = path.join(parent, "proj");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "occupied.txt"), "x");
    const init = await runCliJson(
      ["init", "--template", "ingest-transfers", "--output", out, "--json"],
      parent,
    );
    expect(init.ok).toBe(false);
    expect(init.error?.code).toBe("validation");
  });
});
