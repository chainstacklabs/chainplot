import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

// A8 fixture amounts as decimal strings (int256 range, including 2^256-1).
const AMOUNTS = [
  "0",
  "1",
  "-1",
  "9007199254740993", // 2^53+1
  "-9007199254740993",
  "57896044618658097711785492504343953926634992332820282019728792003956564819967", // 2^255-1
  "-57896044618658097711785492504343953926634992332820282019728792003956564819968", // -2^255
  "115792089237316195423570985008687907853269984665640564039457584007913129639935", // 2^256-1
] as const;

// amount_sort must equal cp_sortkey(amount) exactly — that macro, defined in
// src/query/workerMain.ts, is the one definition of this key. A precomputed
// column and an in-query call have to agree, or a snapshot and a query sort
// the same data differently.
//
//   negative     → '0' + nines-complement of the zero-padded magnitude
//   non-negative → '1' + zero-padded magnitude
//
// The leading sign digit puts every negative first; complementing the
// magnitude reverses its order, so -10 sorts before -9.
const SORT_WIDTH = 78;
const SORT_RADIX = 10n ** BigInt(SORT_WIDTH);

function amountSort(amount: string): string {
  const value = BigInt(amount);
  if (value >= 0n) {
    return "1" + value.toString().padStart(SORT_WIDTH, "0");
  }
  const complement = SORT_RADIX - 1n + value;
  return "0" + complement.toString().padStart(SORT_WIDTH, "0");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = path.join(
  repoRoot,
  "templates/fixture-transfers/snapshots/amounts.parquet",
);

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
try {
  await conn.run("CREATE TABLE amounts (amount VARCHAR, amount_sort VARCHAR)");
  const insert = await conn.prepare(
    "INSERT INTO amounts (amount, amount_sort) VALUES (?, ?)",
  );
  for (const amount of AMOUNTS) {
    insert.bindVarchar(1, amount);
    insert.bindVarchar(2, amountSort(amount));
    await insert.run();
  }
  insert.destroySync();

  const copy = await conn.prepare("COPY amounts TO ? (FORMAT PARQUET)");
  copy.bindVarchar(1, outPath);
  await copy.run();
  copy.destroySync();
} finally {
  conn.closeSync();
  instance.closeSync();
}
