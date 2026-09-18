import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";
import { runCli } from "../../src/cli/run.js";
import { closeActiveServer, serveCommand } from "../../src/cli/commands/serve.js";
import { startServe } from "../../src/publish/serve.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("serve", () => {
  it("serves the release over loopback HTTP only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-serve-"));
    fs.cpSync(template, dir, { recursive: true });
    await runCliJson(["build", "--json"], dir);
    const dist = path.join(dir, "dist/releases/local");

    const server = startServe(dist, 0);
    try {
      await server.ready;
      const url = `http://127.0.0.1:${server.port}`;
      const index = await fetch(`${url}/index.html`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("<div id=\"root\">");
      const release = await fetch(`${url}/release.json`);
      expect(release.status).toBe(200);
      const rel = (await release.json()) as { project_id: string };
      expect(rel.project_id).toBe("fixture-transfers");
      const missing = await fetch(`${url}/nope.json`);
      expect(missing.status).toBe(404);
      const traversal = await fetch(`${url}/../chainplot.yaml`);
      expect(traversal.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("missing directory → validation error", async () => {
    const result = await runCliJson(
      ["serve", "--dir", "/nonexistent-xyz", "--json"],
      os.tmpdir(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});

describe("serve command", () => {
  it("reports the port it actually bound, not the 0 it was asked for", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-serve-port-"));
    fs.cpSync(template, dir, { recursive: true });
    await runCliJson(["build", "--json"], dir);

    const result = await serveCommand(dir);
    try {
      expect(result.ok).toBe(true);
      const { url } = result.data as { url: string };
      expect(new URL(url).port).not.toBe("0");
      const response = await fetch(`${url}/release.json`);
      expect(response.status).toBe(200);
    } finally {
      closeActiveServer();
    }
  });
});

describe("cli gating", () => {
  // A refusal that has already done the work is not a refusal: a caller that
  // trusts `ok: false` and retries would build or publish twice.
  it("refuses a missing --json before the command runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-gate-"));
    fs.cpSync(template, dir, { recursive: true });

    const result = await runCli(["build"], { cwd: dir });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("--json is required");
    expect(fs.existsSync(path.join(dir, "dist", "releases"))).toBe(false);
  });
});

// Inside the producer container the default loopback is the container's own,
// so the documented preview step printed a URL nothing on the host could
// reach. `--host 0.0.0.0` plus a published port is the fix; the reported URL
// must still be the one that works from a host browser.
describe("serve --host", () => {
  it("binds the requested address and reports a loopback URL for it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-serve-host-"));
    fs.cpSync(template, dir, { recursive: true });
    await runCliJson(["build", "--json"], dir);

    const result = await serveCommand(dir, undefined, 0, "0.0.0.0");
    try {
      expect(result.ok).toBe(true);
      const { url } = result.data as { url: string };
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect((await fetch(`${url}/release.json`)).status).toBe(200);
    } finally {
      closeActiveServer();
    }
  });

  it("is accepted on the command line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-serve-cli-"));
    fs.cpSync(template, dir, { recursive: true });
    await runCliJson(["build", "--json"], dir);
    const result = await runCliJson(["serve", "--host", "0.0.0.0", "--json"], dir);
    try {
      expect(result.ok).toBe(true);
      expect((result.data as { url: string }).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      closeActiveServer();
    }
  });
});
