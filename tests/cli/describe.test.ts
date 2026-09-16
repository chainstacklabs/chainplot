import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

describe("dataset describe", () => {
  it("describes the fixture snapshot", async () => {
    const result = await runCliJson(
      ["dataset", "describe", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      id: "amounts",
      mode: "dataset_included",
    });
    const cols = (result.data as { columns: { name: string }[] }).columns.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["amount", "amount_sort"]));
  });
});
