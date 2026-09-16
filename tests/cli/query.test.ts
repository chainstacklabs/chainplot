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

describe("query", () => {
  it("returns 2^256-1 as a decimal string, not a number", async () => {
    const sql = path.join(os.tmpdir(), "q-a8.sql");
    fs.writeFileSync(sql, "SELECT amount FROM amounts ORDER BY amount_sort");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(true);
    const rows = (result.data as { rows: string[][] }).rows;
    const amounts = rows.map((r) => r[0]);
    expect(typeof amounts[0]).toBe("string");
    expect(amounts).toContain(
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
    );
    expect(amounts[0]).toBe(
      "-57896044618658097711785492504343953926634992332820282019728792003956564819968",
    );
  });

  it("maps worker SQL errors to validation", async () => {
    const sql = path.join(os.tmpdir(), "q-invalid.sql");
    fs.writeFileSync(sql, "SELECT definitely_not_a_column FROM amounts");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("rejects ORDER BY on a raw amount column", async () => {
    const sql = path.join(os.tmpdir(), "q-bad.sql");
    fs.writeFileSync(sql, "SELECT amount FROM amounts ORDER BY amount");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      template,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("executes a query that consumes a project model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-query-model-"));
    fs.cpSync(template, dir, { recursive: true });
    const yaml = path.join(dir, "chainplot.yaml");
    fs.appendFileSync(
      yaml,
      "\nmodels:\n  - id: total_rows\n    file: models/total_rows.sql\n    depends_on: []\n",
    );
    fs.mkdirSync(path.join(dir, "models"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "models/total_rows.sql"),
      "SELECT count(*) AS cnt FROM amounts",
    );
    const sql = path.join(dir, "queries/consume_model.sql");
    fs.writeFileSync(sql, "SELECT cnt FROM total_rows");
    const result = await runCliJson(
      ["query", "--file", sql, "--snapshot", "amounts", "--json"],
      dir,
    );
    expect(result.ok).toBe(true);
    const rows = (result.data as { rows: unknown[][] }).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]![0])).toBeGreaterThan(0);
  });
});
