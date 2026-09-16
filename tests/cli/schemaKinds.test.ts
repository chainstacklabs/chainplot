import { describe, expect, it } from "vitest";
import { runCliJson } from "../helpers/run.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.dirname(fileURLToPath(import.meta.url));

describe("frozen M2 schema kinds", () => {
  for (const kind of ["plan", "coverage", "progress"]) {
    it(`${kind} is closed (additionalProperties false)`, async () => {
      const result = await runCliJson(["schema", "show", kind, "--json"], cwd);
      expect(result.ok).toBe(true);
      const schema = result.data as { additionalProperties: boolean };
      expect(schema.additionalProperties).toBe(false);
    });
  }

  it("coverage requires segment boundary hashes", async () => {
    const result = await runCliJson(["schema", "show", "coverage", "--json"], cwd);
    expect(result.ok).toBe(true);
    const schema = result.data as {
      $defs: Record<string, { required: string[] }>;
    };
    expect(schema.$defs.segment.required).toEqual(
      expect.arrayContaining([
        "start_block",
        "end_block",
        "start_block_hash",
        "end_block_hash",
        "start_block_parent_hash",
        "status",
      ]),
    );
  });

  it("progress requires run_id and stage", async () => {
    const result = await runCliJson(["schema", "show", "progress", "--json"], cwd);
    expect(result.ok).toBe(true);
    const schema = result.data as { required: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(["schema_version", "type", "run_id", "stage"]),
    );
  });

  it("plan freezes the M2 plan shape", async () => {
    const result = await runCliJson(["schema", "show", "plan", "--json"], cwd);
    expect(result.ok).toBe(true);
    const schema = result.data as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schema_version",
        "intent",
        "project_id",
        "project_digest",
        "chain",
        "sources",
        "actions",
        "state_assumptions",
      ]),
    );
    expect(schema.properties.schema_version).toMatchObject({ const: 1 });
  });
});
