import type { Query, RawAmountColumn, RawAmountColumnSpec } from "./types.js";

/**
 * Column metadata as it reaches a release, and from there the viewer.
 *
 * `raw_amount` marks a column whose value is an exact integer carried as a
 * decimal string. `decimals`/`symbol` say how to *display* it; neither ever
 * changes what is stored, so a uint256 still round-trips exactly (spec §12).
 */
export interface ResultColumn {
  name: string;
  logical_type: string;
  raw_amount?: true;
  decimals?: number;
  symbol?: string;
  label?: string;
}

/** Accept both the bare-name and the descriptor form of a raw amount column. */
export function normalizeRawAmountColumns(
  spec: RawAmountColumnSpec[] | undefined,
): RawAmountColumn[] {
  return (spec ?? []).map((entry) =>
    typeof entry === "string" ? { name: entry } : entry,
  );
}

export function rawAmountNames(
  spec: RawAmountColumnSpec[] | undefined,
): string[] {
  return normalizeRawAmountColumns(spec).map((column) => column.name);
}

/**
 * Attach a query's declared display metadata to the columns DuckDB reported.
 * Matching is case-insensitive because SQL identifiers are.
 */
export function decorateColumns(
  columns: { name: string; logical_type: string }[],
  spec: RawAmountColumnSpec[] | undefined,
): ResultColumn[] {
  const declared = new Map(
    normalizeRawAmountColumns(spec).map((column) => [
      column.name.toLowerCase(),
      column,
    ]),
  );
  return columns.map((column) => {
    const meta = declared.get(column.name.toLowerCase());
    if (!meta) return { name: column.name, logical_type: column.logical_type };
    return {
      name: column.name,
      logical_type: column.logical_type,
      raw_amount: true as const,
      ...(meta.decimals === undefined ? {} : { decimals: meta.decimals }),
      ...(meta.symbol === undefined ? {} : { symbol: meta.symbol }),
      ...(meta.label === undefined ? {} : { label: meta.label }),
    };
  });
}

/** Panel heading precedence: panel title, then query title, then query id. */
export function queryTitle(query: Pick<Query, "id" | "title">): string {
  return query.title ?? query.id;
}
