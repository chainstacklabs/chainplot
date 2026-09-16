import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("capabilities", () => {
  it("prints one JSON object with integer schema_version", async () => {
    const result = await runCliJson(["capabilities", "--json"], cwd);
    expect(result.schema_version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.command).toBe("capabilities");
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      schema_kinds: expect.arrayContaining(["project", "progress", "latest"]),
      sql_modes: ["snapshot"],
      sources: [],
      publish_targets: [],
    });
  });
});
