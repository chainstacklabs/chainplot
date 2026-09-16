import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQuery } from "../../src/query/runQuery.js";

function tempCopyOfFixture(): string {
  const src = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates/fixture-transfers/snapshots/amounts.parquet",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-models-"));
  const dest = path.join(dir, "amounts.parquet");
  fs.copyFileSync(src, dest);
  return dest;
}

describe("model materialization", () => {
  it("query consumes a materialized model", async () => {
    const parquet = tempCopyOfFixture();
    const result = await runQuery({
      sql: "SELECT n FROM daily_totals ORDER BY n",
      tables: { amounts: parquet },
      rawAmountColumns: [],
      rowLimit: 10_000,
      models: [
        {
          id: "daily_totals",
          sql: "SELECT amount_sort, COUNT(*) AS n FROM amounts GROUP BY amount_sort",
        },
      ],
    });
    expect(result.columns.map((c) => c.name)).toEqual(["n"]);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("model on top of model, in array order", async () => {
    const parquet = tempCopyOfFixture();
    const result = await runQuery({
      sql: "SELECT total FROM grand_total",
      tables: { amounts: parquet },
      rawAmountColumns: [],
      rowLimit: 10_000,
      models: [
        {
          id: "daily_totals",
          sql: "SELECT amount_sort, COUNT(*) AS n FROM amounts GROUP BY amount_sort",
        },
        {
          id: "grand_total",
          sql: "SELECT SUM(n) AS total FROM daily_totals",
        },
      ],
    });
    expect(result.rows).toHaveLength(1);
  });

  it("non-SELECT model SQL → validation error", async () => {
    const parquet = tempCopyOfFixture();
    await expect(
      runQuery({
        sql: "SELECT 1",
        tables: { amounts: parquet },
        rawAmountColumns: [],
        rowLimit: 10_000,
        models: [{ id: "evil", sql: "CREATE TABLE x AS SELECT 1" }],
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  // The snapshot is the only file this process may read, and models are no
  // more trusted than the query: `fork` writes a stranger's models straight
  // into the project. External access must already be off by the time they run.
  it("model cannot read the filesystem", async () => {
    const parquet = tempCopyOfFixture();
    const canary = path.join(path.dirname(parquet), "canary.txt");
    fs.writeFileSync(canary, "SECRET");
    await expect(
      runQuery({
        sql: "SELECT leaked FROM exfil",
        tables: { amounts: parquet },
        rawAmountColumns: [],
        rowLimit: 10_000,
        models: [
          {
            id: "exfil",
            sql: `SELECT content AS leaked FROM read_text('${canary}')`,
          },
        ],
      }),
    ).rejects.toThrow(/file system operations are disabled/);
  });

  // httpfs also cannot autoload here; the filesystem test above is what
  // actually pins enable_external_access.
  it("model cannot reach the network", async () => {
    const parquet = tempCopyOfFixture();
    await expect(
      runQuery({
        sql: "SELECT * FROM exfil",
        tables: { amounts: parquet },
        rawAmountColumns: [],
        rowLimit: 10_000,
        models: [
          {
            id: "exfil",
            sql: "SELECT * FROM read_csv('https://example.invalid/x.csv')",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("multi-statement query is refused", async () => {
    const parquet = tempCopyOfFixture();
    await expect(
      runQuery({
        sql: "SELECT 1 AS a; SELECT 2 AS b",
        tables: { amounts: parquet },
        rawAmountColumns: [],
        rowLimit: 10_000,
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("failing model surfaces the model id", async () => {
    const parquet = tempCopyOfFixture();
    await expect(
      runQuery({
        sql: "SELECT * FROM broken",
        tables: { amounts: parquet },
        rawAmountColumns: [],
        rowLimit: 10_000,
        models: [{ id: "broken", sql: "SELECT nope FROM amounts" }],
      }),
    ).rejects.toThrow(/broken/);
  });

  describe("raw amount ORDER BY guard", () => {
    const refused = [
      ["bare column", "SELECT amount FROM amounts ORDER BY amount"],
      ["select-list alias", "SELECT amount AS v FROM amounts ORDER BY v"],
      ["positional ordinal", "SELECT amount FROM amounts ORDER BY 1"],
    ] as const;

    for (const [label, sql] of refused) {
      it(`refuses ${label}`, async () => {
        await expect(
          runQuery({
            sql,
            tables: { amounts: tempCopyOfFixture() },
            rawAmountColumns: ["amount"],
            rowLimit: 10_000,
          }),
        ).rejects.toMatchObject({ code: "validation" });
      });
    }

    it("allows an explicit sort key and orders it numerically", async () => {
      const result = await runQuery({
        sql: "SELECT amount FROM amounts ORDER BY cp_sortkey(amount)",
        tables: { amounts: tempCopyOfFixture() },
        rawAmountColumns: ["amount"],
        rowLimit: 10_000,
      });
      const got = result.rows.map((row) => String(row[0]));
      const want = [...got].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
      );
      expect(got).toEqual(want);
      // The fixture spans the full signed range, negatives included.
      expect(got[0]!.startsWith("-")).toBe(true);
      expect(got.at(-1)).toBe(
        "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      );
    });
  });

  // The fixture carries a precomputed amount_sort; scripts/write-fixture-parquet.ts
  // and the cp_sortkey macro must stay one definition, or a snapshot column and
  // an in-query call would order the same data differently.
  it("the precomputed sort column equals cp_sortkey exactly", async () => {
    const result = await runQuery({
      sql:
        "SELECT count(*) FILTER (WHERE amount_sort <> cp_sortkey(amount))::VARCHAR AS mismatches," +
        " count(*)::VARCHAR AS total FROM amounts",
      tables: { amounts: tempCopyOfFixture() },
      rawAmountColumns: ["amount"],
      rowLimit: 10_000,
    });
    expect(result.rows[0]?.[0]).toBe("0");
    expect(result.rows[0]?.[1]).toBe("8");
  });

  // security.md lists resource exhaustion by a forked recipe as a real risk;
  // the memory cap is the control, and it must spill rather than fail.
  it("caps query memory and spills instead of failing", async () => {
    const result = await runQuery({
      sql:
        "SELECT current_setting('memory_limit') AS limit_setting," +
        " (current_setting('temp_directory') <> '')::VARCHAR AS has_spill_dir",
      tables: { amounts: tempCopyOfFixture() },
      rawAmountColumns: [],
      rowLimit: 10,
    });
    expect(String(result.rows[0]?.[0])).toMatch(/MiB|GiB/);
    expect(String(result.rows[0]?.[1])).toBe("true");
  });

  it("refuses to truncate: over the row limit is a typed refusal", async () => {
    await expect(
      runQuery({
        sql: "SELECT i FROM range(50) t(i)",
        tables: { amounts: tempCopyOfFixture() },
        rawAmountColumns: [],
        rowLimit: 10,
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });
});
