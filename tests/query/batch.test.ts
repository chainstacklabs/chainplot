import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQueries } from "../../src/query/runQuery.js";

function tempCopyOfFixture(): string {
  const src = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../templates/fixture-transfers/snapshots/amounts.parquet",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-batch-"));
  const dest = path.join(dir, "amounts.parquet");
  fs.copyFileSync(src, dest);
  return dest;
}

const query = (id: string, sql: string, rowLimit = 10_000) => ({
  id,
  sql,
  rawAmountColumns: [],
  rowLimit,
});

// A build used to fork one worker per query, and each worker loaded every
// snapshot and rebuilt every model before running its one SELECT. A batch
// loads and builds once, then runs the queries in turn.
describe("query batches", () => {
  it("runs every query against one build of the models, in order", async () => {
    const results = await runQueries({
      tables: { amounts: tempCopyOfFixture() },
      // random() is drawn once per build of the model, so two queries
      // reading the same value prove they shared one build.
      models: [{ id: "drawn", sql: "SELECT random() AS r, (SELECT COUNT(*) FROM amounts) AS n" }],
      queries: [query("first", "SELECT r, n FROM drawn"), query("second", "SELECT r FROM drawn")],
    });
    expect(results.map((r) => r.id)).toEqual(["first", "second"]);
    expect(results[0]!.rows[0]![1]).toBe("8");
    expect(results[1]!.rows[0]![0]).toBe(results[0]!.rows[0]![0]);
  });

  it("names the query that failed", async () => {
    const run = runQueries({
      tables: { amounts: tempCopyOfFixture() },
      queries: [
        query("fine", "SELECT COUNT(*) FROM amounts"),
        query("broken", "SELECT no_such_column FROM amounts"),
      ],
    });
    await expect(run).rejects.toMatchObject({ code: "validation", resource_id: "broken" });
  });

  it("names a failing model rather than the query that would have used it", async () => {
    const run = runQueries({
      tables: { amounts: tempCopyOfFixture() },
      models: [{ id: "bad", sql: "SELECT nope FROM amounts" }],
      queries: [query("uses_bad", "SELECT * FROM bad")],
    });
    await expect(run).rejects.toMatchObject({ code: "validation", resource_id: "bad" });
  });

  it("holds each query to its own row limit, and says which one overran", async () => {
    const run = runQueries({
      tables: { amounts: tempCopyOfFixture() },
      queries: [
        query("small", "SELECT 1"),
        query("too_big", "SELECT * FROM range(50)", 10),
      ],
    });
    await expect(run).rejects.toMatchObject({ code: "policy_refused", resource_id: "too_big" });
  });

  it("keeps external access shut for every query, not just the first", async () => {
    const run = runQueries({
      tables: { amounts: tempCopyOfFixture() },
      queries: [
        query("fine", "SELECT 1"),
        query("reads_disk", "SELECT * FROM read_csv('/etc/passwd')"),
      ],
    });
    await expect(run).rejects.toMatchObject({ resource_id: "reads_disk" });
  });

  it("gives each query its own deadline, and names the one that ran out", async () => {
    const run = runQueries(
      {
        tables: { amounts: tempCopyOfFixture() },
        queries: [
          query("quick", "SELECT 1"),
          // About 10^10 rows: far longer than the deadline below.
          query("slow", "SELECT SUM(a.range * b.range) FROM range(100000) a, range(100000) b"),
        ],
      },
      { deadlineMs: 1_500 },
    );
    await expect(run).rejects.toMatchObject({
      code: "transient_dependency",
      resource_id: "slow",
    });
  });

  it("runs nothing for an empty batch", async () => {
    expect(await runQueries({ tables: {}, queries: [] })).toEqual([]);
  });
});
