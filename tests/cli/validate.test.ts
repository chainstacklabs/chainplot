import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/projects",
);
const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("validate", () => {
  it("accepts a dataset-only project", async () => {
    const result = await runCliJson(["validate", "--json"], template);
    expect(result.ok).toBe(true);
    expect(result.command).toBe("validate");
  });

  it("rejects malformed YAML with a validation envelope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-bad-yaml-"));
    fs.writeFileSync(path.join(dir, "chainplot.yaml"), "id: [unterminated\n");
    const result = await runCliJson(["validate", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.schema_version).toBe(1);
    expect(result.error?.code).toBe("validation");
  });

  it("rejects unknown fields", async () => {
    const result = await runCliJson(["validate", "--json"], path.join(fixtures, "unknown-field"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("rejects follow_finalized plus confirmation_depth", async () => {
    const result = await runCliJson(["validate", "--json"], path.join(fixtures, "follow-plus-depth"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unsupported_capability");
  });

  it("rejects missing model file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-missing-model-"));
    fs.cpSync(template, dir, { recursive: true });
    const yaml = path.join(dir, "chainplot.yaml");
    fs.appendFileSync(
      yaml,
      "\nmodels:\n  - id: non_existent\n    file: models/non_existent.sql\n    depends_on: []\n",
    );
    const result = await runCliJson(["validate", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toContain("missing model file");
  });
});

// rindexer turns an event name into a Postgres identifier, and Postgres stops
// at 63 characters. A project past that limit indexes fine and then cannot
// find its own tables, so `validate` refuses it with the fix spelled out.
describe("validate refuses table names rindexer would compact", () => {
  it("names the source and the event", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-longname-"));
    fs.cpSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/ingest-transfers"),
      dir,
      { recursive: true },
    );
    const yamlPath = path.join(dir, "chainplot.yaml");
    fs.writeFileSync(
      yamlPath,
      fs
        .readFileSync(yamlPath, "utf8")
        .replace("      - Transfer", "      - TransferWithAVeryLongEventNameThatOverflowsAPostgresIdentifier"),
    );
    const result = await runCliJson(["validate", "--json"], dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
    expect(result.error?.message).toMatch(/63/);
    expect(result.error?.pointer).toBe("/event_sources/0/events");
  });
});
