import { describe, expect, it } from "vitest";
import {
  asBigInt,
  columnLabel,
  compareValues,
  displayAmount,
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
    expect(displayAmount(1_999_999n, 6)).toBe("2");
    expect(displayAmount(-1_999_999n, 6)).toBe("-2");
    expect(displayAmount(1_005_000n, 6)).toBe("1.01");
  });

  it("keeps full precision below one unit, where the fraction is the value", () => {
    expect(displayAmount(1n, 18)).toBe("0.000000000000000001");
    expect(displayAmount(-1n, 18)).toBe("-0.000000000000000001");
  });

  it("leaves a value that needs no rounding untouched", () => {
    const cell = formatCell("1500000", usdc);
    expect(cell.text).toBe("1.5 USDC");
    expect(cell.exact).toBe("1500000");
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
