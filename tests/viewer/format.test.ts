import { describe, expect, it } from "vitest";
import {
  asBigInt,
  columnLabel,
  compareValues,
  displayAmount,
  isNumericColumn,
  formatCell,
  groupDigits,
  relativeTime,
  rowWindow,
  scaleAmount,
  shortHex,
  toChartNumber,
} from "../../viewer/src/format.js";

const UINT256_MAX =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const INT256_MIN =
  "-57896044618658097711785492504343953926634992332820282019728792003956564819968";

describe("groupDigits", () => {
  it("groups in threes from the right", () => {
    expect(groupDigits("1")).toBe("1");
    expect(groupDigits("1000")).toBe("1,000");
    expect(groupDigits("18600010")).toBe("18,600,010");
  });

  it("keeps the sign outside the grouping", () => {
    expect(groupDigits("-1234567")).toBe("-1,234,567");
  });

  it("survives a full uint256 without a float in sight", () => {
    expect(groupDigits(UINT256_MAX).replace(/,/g, "")).toBe(UINT256_MAX);
  });
});

describe("scaleAmount", () => {
  it("applies token decimals exactly", () => {
    expect(scaleAmount(983644533552n, 6)).toBe("983,644.533552");
  });

  it("drops trailing fraction zeros but never rounds the integer part", () => {
    expect(scaleAmount(309175980000n, 6)).toBe("309,175.98");
    expect(scaleAmount(1500000n, 6)).toBe("1.5");
    expect(scaleAmount(1000000n, 6)).toBe("1");
  });

  it("pads a value smaller than one unit", () => {
    expect(scaleAmount(1n, 18)).toBe("0.000000000000000001");
  });

  it("handles negatives", () => {
    expect(scaleAmount(-1500000n, 6)).toBe("-1.5");
  });

  it("is a no-op at zero decimals", () => {
    expect(scaleAmount(42n, 0)).toBe("42");
  });

  it("does not lose precision on uint256", () => {
    expect(scaleAmount(BigInt(UINT256_MAX), 0).replace(/,/g, "")).toBe(UINT256_MAX);
  });
});

describe("asBigInt", () => {
  it("accepts decimal strings and rejects everything else", () => {
    expect(asBigInt("123")).toBe(123n);
    expect(asBigInt("-123")).toBe(-123n);
    expect(asBigInt(" 7 ")).toBe(7n);
    expect(asBigInt("0x1f")).toBeNull();
    expect(asBigInt("1.5")).toBeNull();
    expect(asBigInt("")).toBeNull();
    expect(asBigInt(null)).toBeNull();
  });
});

describe("formatCell", () => {
  const usdc = {
    name: "value",
    logical_type: "VARCHAR",
    raw_amount: true,
    decimals: 6,
    symbol: "USDC",
  };

  it("scales and labels a raw amount, keeping the exact value available", () => {
    const cell = formatCell("983644533552", usdc);
    // Display rounds past one unit; the exact figure rides on the title.
    expect(cell.text).toBe("983,644.53 USDC");
    expect(cell.exact).toContain("983,644.533552");
    expect(cell.exact).toContain("983644533552");
    expect(cell.numeric).toBe(true);
  });

  it("groups a plain integer column", () => {
    expect(
      formatCell(18600010, { name: "block_number", logical_type: "INTEGER" }).text,
    ).toBe("18,600,010");
  });

  it("middle-truncates a long hash but keeps the full value for the title", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const cell = formatCell(hash, { name: "tx_hash", logical_type: "VARCHAR" });
    expect(cell.text).toContain("…");
    expect(cell.text.length).toBeLessThan(hash.length);
    expect(cell.exact).toBe(hash);
  });

  it("renders null as a dash rather than an empty cell", () => {
    expect(formatCell(null, { name: "x", logical_type: "VARCHAR" }).text).toBe("—");
  });

  it("falls back to the raw text when an amount is not an integer", () => {
    expect(formatCell("n/a", usdc).text).toBe("n/a");
  });
});

describe("toChartNumber", () => {
  it("scales in BigInt space before touching a double", () => {
    expect(
      toChartNumber("983644533552", {
        name: "v",
        logical_type: "VARCHAR",
        raw_amount: true,
        decimals: 6,
      }),
    ).toBeCloseTo(983644.533552, 5);
  });

  it("plots a value far beyond Number.MAX_SAFE_INTEGER without throwing", () => {
    const plotted = toChartNumber(UINT256_MAX, {
      name: "v",
      logical_type: "VARCHAR",
      raw_amount: true,
      decimals: 18,
    });
    expect(Number.isFinite(plotted)).toBe(true);
    expect(plotted).toBeGreaterThan(0);
  });
});

describe("compareValues", () => {
  it("orders the full signed range numerically, not lexicographically", () => {
    const values = ["10", "9", "-1", INT256_MIN, UINT256_MAX, "0"];
    expect([...values].sort(compareValues)).toEqual([
      INT256_MIN,
      "-1",
      "0",
      "9",
      "10",
      UINT256_MAX,
    ]);
  });

  it("falls back to text for non-numeric values", () => {
    expect(compareValues("0xbb", "0xaa")).toBe(1);
  });
});

describe("columnLabel", () => {
  it("prefers the declared label", () => {
    expect(columnLabel({ name: "value", logical_type: "VARCHAR", label: "Amount" })).toBe(
      "Amount",
    );
  });

  it("humanises a snake_case column name otherwise", () => {
    expect(columnLabel({ name: "block_number", logical_type: "INTEGER" })).toBe(
      "Block number",
    );
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  it("describes the recent past", () => {
    expect(relativeTime("2026-09-15T10:00:00Z", now)).toMatch(/2 hours ago/);
  });

  it("returns null for missing or unparseable input", () => {
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime("not a date", now)).toBeNull();
  });
});

describe("shortHex", () => {
  it("leaves short values alone", () => {
    expect(shortHex("0xabc")).toBe("0xabc");
  });
});

// Six decimals on a figure in the billions is noise, and it wrapped the
// headline number onto two lines. Rounding is display-only: the exact figure
// and the raw integer both stay reachable.
describe("display rounding", () => {
  const usdc = {
    name: "v",
    logical_type: "VARCHAR",
    raw_amount: true,
    decimals: 6,
    symbol: "USDC",
  };

  it("shows two decimals once past one unit", () => {
    const cell = formatCell("21972372081082838", usdc);
    expect(cell.text).toBe("21,972,372,081.08 USDC");
  });

  it("keeps the exact figure and the raw integer on hover", () => {
    const cell = formatCell("21972372081082838", usdc);
    expect(cell.exact).toContain("21,972,372,081.082838");
    expect(cell.exact).toContain("21972372081082838");
  });

  it("rounds half away from zero rather than truncating", () => {
    expect(displayAmount(1_999_999n, 6)).toBe("2.00");
    expect(displayAmount(-1_999_999n, 6)).toBe("-2.00");
    expect(displayAmount(1_005_000n, 6)).toBe("1.01");
  });

  // A column of amounts is read down the decimal point. Trimming the zeros
  // here would print "9,000,000", "1,499,999.5" and "101,570,558.71" in one
  // column, which is what the exact rendering is for.
  it("pads every rounded figure to the same width", () => {
    expect(displayAmount(9_000_000_000_000n, 6)).toBe("9,000,000.00");
    expect(displayAmount(1_499_999_500_000n, 6)).toBe("1,499,999.50");
    expect(displayAmount(101_570_558_713_200n, 6)).toBe("101,570,558.71");
  });

  it("still trims trailing zeros when rendering an exact value", () => {
    expect(scaleAmount(9_000_000_000_000n, 6)).toBe("9,000,000");
    expect(scaleAmount(1_499_999_500_000n, 6)).toBe("1,499,999.5");
  });

  it("keeps full precision below one unit, where the fraction is the value", () => {
    expect(displayAmount(1n, 18)).toBe("0.000000000000000001");
    expect(displayAmount(-1n, 18)).toBe("-0.000000000000000001");
  });

  it("pads a value that needs no rounding, and reveals it exactly on hover", () => {
    const cell = formatCell("1500000", usdc);
    expect(cell.text).toBe("1.50 USDC");
    expect(cell.exact).toContain("1.5 USDC");
    expect(cell.exact).toContain("1500000");
  });

  it("does not round integer columns that are not amounts", () => {
    expect(formatCell(18600010, { name: "b", logical_type: "BIGINT" }).text).toBe(
      "18,600,010",
    );
  });
});

// Results ride inside the release, so a wide table would otherwise put every
// row in the DOM. The window is the part worth testing without a browser.
describe("rowWindow", () => {
  const opts = { threshold: 200, overscan: 10 };

  it("renders everything below the threshold", () => {
    const w = rowWindow(150, 0, 400, 33, opts);
    expect(w).toEqual({ virtual: false, first: 0, last: 150 });
  });

  it("windows a large result and keeps the slice inside it", () => {
    const w = rowWindow(5000, 0, 458, 34, opts);
    expect(w.virtual).toBe(true);
    expect(w.first).toBe(0);
    expect(w.last).toBeLessThan(50);
  });

  it("tracks the scroll position", () => {
    const w = rowWindow(5000, 34 * 2500, 458, 34, opts);
    expect(w.first).toBe(2490);
    expect(w.last).toBeGreaterThan(2500);
    expect(w.last).toBeLessThan(2530);
  });

  it("clamps to the end of the result", () => {
    const w = rowWindow(5000, 34 * 5000, 458, 34, opts);
    expect(w.last).toBe(5000);
    expect(w.first).toBeLessThan(5000);
  });

  it("never returns a negative start", () => {
    expect(rowWindow(5000, 0, 458, 34, opts).first).toBe(0);
  });

  it("renders the overscan before the container has been measured", () => {
    // viewport 0 is the first paint; rendering nothing would look empty.
    const w = rowWindow(5000, 0, 0, 34, opts);
    expect(w.last).toBeGreaterThan(w.first);
  });

  it("falls back to rendering everything if a row height is unknown", () => {
    expect(rowWindow(5000, 0, 400, 0, opts).virtual).toBe(false);
  });
});

// Alignment follows the column, not the value. Deciding per cell put a null,
// which has no digits, out of line with the figures above it, and left-aligned
// a header over right-aligned cells.
describe("isNumericColumn", () => {
  it("treats a declared amount as numeric however it is typed", () => {
    expect(
      isNumericColumn({ name: "v", logical_type: "VARCHAR", raw_amount: true }, [null]),
    ).toBe(true);
  });

  it("treats a numeric logical type as numeric even when every value is null", () => {
    expect(isNumericColumn({ name: "n", logical_type: "BIGINT" }, [null, null])).toBe(true);
    expect(isNumericColumn({ name: "d", logical_type: "DECIMAL(18,3)" }, [])).toBe(true);
    expect(isNumericColumn({ name: "h", logical_type: "HUGEINT" }, [])).toBe(true);
    expect(isNumericColumn({ name: "u", logical_type: "UBIGINT" }, [])).toBe(true);
  });

  it("settles a VARCHAR by its values, so an undeclared uint256 still reads as one", () => {
    const column = { name: "v", logical_type: "VARCHAR" };
    expect(isNumericColumn(column, ["1", "115792089237316195423570985008687907853269984665640564039457584007913129639935"])).toBe(true);
    expect(isNumericColumn(column, ["1", null, "2"])).toBe(true);
  });

  // A list of numbers is not a number: it renders as "[1, 2, 3]" and belongs
  // on the left with the text. An unanchored type match accepts "INTEGER[]".
  it("does not treat a list of numbers as a number column", () => {
    for (const logical_type of ["INTEGER[]", "UBIGINT[]", "DECIMAL(18,3)[]", "DOUBLE[]"]) {
      expect(isNumericColumn({ name: "l", logical_type }, [])).toBe(false);
      expect(isNumericColumn({ name: "l", logical_type }, [[1, 2]])).toBe(false);
    }
    expect(isNumericColumn({ name: "s", logical_type: "STRUCT(a INTEGER)" }, [])).toBe(false);
  });

  it("accepts the scalar numeric types as DuckDB spells them", () => {
    for (const logical_type of [
      "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
      "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
      "FLOAT", "REAL", "DOUBLE", "DECIMAL(18,3)", "DECIMAL",
    ]) {
      expect(isNumericColumn({ name: "n", logical_type }, [])).toBe(true);
    }
  });

  // Only text is settled by its values. A BIT string is "0101" and an enum
  // label can be any text at all; neither is a number because it reads like
  // digits.
  it("does not infer from the values of a type that is not text", () => {
    expect(isNumericColumn({ name: "b", logical_type: "BIT" }, ["0101", "1"])).toBe(false);
    expect(isNumericColumn({ name: "e", logical_type: "ENUM('1','2')" }, ["1", "2"])).toBe(false);
    expect(isNumericColumn({ name: "d", logical_type: "DATE" }, ["20260916"])).toBe(false);
    expect(isNumericColumn({ name: "u", logical_type: "UUID" }, ["12345"])).toBe(false);
  });

  it("does not call a VARCHAR numeric on the strength of some of its values", () => {
    const column = { name: "v", logical_type: "VARCHAR" };
    expect(isNumericColumn(column, ["1", "Ethereum"])).toBe(false);
    expect(isNumericColumn(column, ["00:26:20"])).toBe(false);
    expect(isNumericColumn(column, [])).toBe(false);
    expect(isNumericColumn(column, [null, null])).toBe(false);
  });
});
