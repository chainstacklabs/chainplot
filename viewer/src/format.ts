// Display formatting for values that must not lose precision.
//
// Amounts arrive as decimal strings because a uint256 does not fit in a
// double. Every transform here stays in BigInt or string space; `Number` is
// used only for chart geometry, where a pixel is the unit anyway and the
// exact value is still shown on hover.

export interface ColumnMeta {
  name: string;
  logical_type: string;
  raw_amount?: boolean;
  decimals?: number;
  symbol?: string;
  label?: string;
}

const DECIMAL = /^-?\d+$/;

export function asBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Group the integer part in threes without going through Number. */
export function groupDigits(digits: string): string {
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  let out = "";
  for (let i = body.length; i > 0; i -= 3) {
    const start = Math.max(0, i - 3);
    out = body.slice(start, i) + (out ? "," + out : "");
  }
  return (negative ? "-" : "") + out;
}

/**
 * Scale an integer amount by `decimals`, exactly.
 *
 * 983644533552 with 6 decimals → "983,644.533552". Trailing zeros in the
 * fraction are dropped; the integer part is never rounded.
 */
export function scaleAmount(value: bigint, decimals: number): string {
  if (decimals <= 0) return groupDigits(value.toString());
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const body = groupDigits(whole) + (fraction ? `.${fraction}` : "");
  return (negative ? "-" : "") + body;
}

/**
 * Round an implied-decimal integer to `keep` decimal places, half away from
 * zero, entirely in BigInt. Used for display only — the exact value is always
 * still available, and `scaleAmount` remains the lossless rendering.
 */
export function roundAmount(value: bigint, decimals: number, keep: number): bigint {
  if (keep >= decimals) return value;
  const drop = BigInt(decimals - keep);
  const divisor = 10n ** drop;
  const half = divisor / 2n;
  return value < 0n ? (value - half) / divisor : (value + half) / divisor;
}

/**
 * How many decimal places are worth showing.
 *
 * Six decimals on a figure in the billions is noise, and it pushes a headline
 * number onto two lines. Below one unit the fraction is the whole story, so it
 * is kept in full.
 */
export function displayDecimals(value: bigint, decimals: number): number {
  if (decimals <= 0) return 0;
  const magnitude = (value < 0n ? -value : value) / 10n ** BigInt(decimals);
  return magnitude === 0n ? decimals : 2;
}

/** Display rendering of a raw amount: exact below one unit, 2dp above. */
export function displayAmount(value: bigint, decimals: number): string {
  const keep = displayDecimals(value, decimals);
  return scaleAmount(roundAmount(value, decimals, keep), keep);
}

/** Middle-truncate a 0x hash so a table column stays readable. */
export function shortHex(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function isHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{16,}$/.test(value);
}

export interface Formatted {
  /** What the cell shows. */
  text: string;
  /** The exact value, for a title attribute and copy. */
  exact: string;
  numeric: boolean;
}

export function formatCell(value: unknown, column: ColumnMeta): Formatted {
  if (value === null || value === undefined) {
    return { text: "—", exact: "", numeric: false };
  }
  const exact = String(value);

  if (column.raw_amount) {
    const amount = asBigInt(value);
    if (amount !== null) {
      const scaled = displayAmount(amount, column.decimals ?? 0);
      const precise = scaleAmount(amount, column.decimals ?? 0);
      return {
        text: column.symbol ? `${scaled} ${column.symbol}` : scaled,
        // Hovering a rounded figure should reveal the full one, then the raw
        // integer it came from.
        exact:
          precise === scaled
            ? exact
            : `${precise}${column.symbol ? ` ${column.symbol}` : ""} (${exact})`,
        numeric: true,
      };
    }
  }

  const asInt = asBigInt(value);
  if (asInt !== null) {
    return { text: groupDigits(asInt.toString()), exact, numeric: true };
  }
  if (typeof value === "number") {
    return { text: String(value), exact, numeric: true };
  }
  if (isHex(value)) {
    return { text: shortHex(value), exact, numeric: false };
  }
  return { text: exact, exact, numeric: false };
}

export function columnLabel(column: ColumnMeta): string {
  if (column.label) return column.label;
  const base = column.name.replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Chart-space value. Scaling happens in BigInt, so only the final magnitude
 * touches a double — an amount too large for one still plots at the right
 * height, and the tooltip carries the exact figure.
 */
export function toChartNumber(value: unknown, column: ColumnMeta): number {
  const amount = asBigInt(value);
  if (amount === null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const decimals = column.raw_amount ? (column.decimals ?? 0) : 0;
  if (decimals <= 0) return Number(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const remainder = amount % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

/** Sign-aware numeric compare, falling back to text for non-numbers. */
export function compareValues(a: unknown, b: unknown): number {
  const left = asBigInt(a);
  const right = asBigInt(b);
  if (left !== null && right !== null) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const as = String(a ?? "");
  const bs = String(b ?? "");
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** "3 minutes ago" / "in 2 hours", or null when the input is unusable. */
export function relativeTime(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.round((then - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

/**
 * Which slice of rows a virtualised table should render.
 *
 * Results ride inside the release, so a wide table would otherwise put every
 * row in the DOM. Spacer rows above and below stand in for what is not
 * rendered, so the scrollbar still spans the whole result.
 */
export interface RowWindow {
  /** Whether windowing applies at all. */
  virtual: boolean;
  /** First row index to render, inclusive. */
  first: number;
  /** Last row index to render, exclusive. */
  last: number;
}

export function rowWindow(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  opts: { threshold: number; overscan: number },
): RowWindow {
  if (total <= opts.threshold || rowHeight <= 0) {
    return { virtual: false, first: 0, last: total };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - opts.overscan);
  const last = Math.min(
    total,
    Math.ceil((scrollTop + viewport) / rowHeight) + opts.overscan,
  );
  // A viewport of zero happens on the first paint, before the container has
  // been measured; render the overscan rather than nothing.
  return { virtual: true, first, last: Math.max(last, first + opts.overscan) };
}
