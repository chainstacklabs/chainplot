import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("schema show", () => {
  it("returns the project schema with additionalProperties false", async () => {
    const result = await runCliJson(["schema", "show", "project", "--json"], cwd);
    expect(result.ok).toBe(true);
    const schema = result.data as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
  });

  it("rejects unknown kind", async () => {
    const result = await runCliJson(["schema", "show", "nope", "--json"], cwd);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});
