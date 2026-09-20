import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("test", () => {
  it("passes fixture assertions", async () => {
    const result = await runCliJson(["test", "--json"], template);
    expect(result.ok).toBe(true);
  });
});
