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

describe("doctor", () => {
  it("offline: rpc/rindexer/s3 skipped, storage checked, no secrets leaked", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of [
      "RPC_URL",
      "DATABASE_URL",
      "CHAINPLOT_RINDEXER_BIN",
      "CHAINPLOT_S3_ENDPOINT",
      "AWS_ACCESS_KEY_ID",
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-doctor-"));
      fs.cpSync(template, dir, { recursive: true });
      const result = await runCliJson(["doctor", "--json"], dir);
      expect(result.ok).toBe(true);
      const byName = Object.fromEntries(
        (result.data as { checks: { name: string; status: string }[] }).checks.map(
          (c) => [c.name, c.status],
        ),
      );
      expect(byName).toMatchObject({ project: "ok", storage: "ok" });
      expect(byName["rpc"]).toBe("skipped");
      expect(byName["rindexer"]).toBe("skipped");
      expect(byName["s3"]).toBe("skipped");
      expect(JSON.stringify(result.data)).not.toMatch(/RPC_URL=/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it("missing project file → fail, not hang", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-doctor-"));
    const result = await runCliJson(["doctor", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});
