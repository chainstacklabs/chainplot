// SQL admission control, built on DuckDB's own parser rather than regexes.
//
// The worker serializes every statement with `json_serialize_sql` before it
// runs. That call has two useful properties:
//
//   1. It refuses anything that is not a SELECT ("Only SELECT statements can
//      be serialized to json!"), so a successful serialize is itself proof
//      that the statement is read-only. No keyword denylist is needed.
//   2. It reports the statement count, so `select 1; drop table t` cannot
//      slip a second statement past a check aimed at the first.
//
// On top of that we walk the AST to reject lexicographic ORDER BY on raw
// amount columns (spec §12). uint256 amounts are carried as decimal strings,
// so `ORDER BY value` silently orders "9" after "10". The check resolves
// select-list aliases and ordinals, which a token scan cannot do.

import type { CommandError } from "../cli/envelope.js";

export interface SqlIssue {
  code: CommandError["code"];
  message: string;
}

/** Shape of `json_serialize_sql` output that we depend on. */
export interface SerializedSql {
  error?: boolean;
  error_message?: string;
  error_subtype?: string;
  statements?: unknown[];
}

interface ColumnRef {
  class: "COLUMN_REF";
  alias?: string;
  column_names?: string[];
}

interface ConstantRef {
  class: "CONSTANT";
  alias?: string;
  value?: { value?: unknown };
}

type Expr = ColumnRef | ConstantRef | { class: string; alias?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asExpr(value: unknown): Expr | null {
  return isObject(value) && typeof value.class === "string"
    ? (value as unknown as Expr)
    : null;
}

/** Final identifier of a column reference: `t.value` → `value`. */
function columnName(expr: Expr | null): string | null {
  if (!expr || expr.class !== "COLUMN_REF") return null;
  const names = (expr as ColumnRef).column_names;
  if (!Array.isArray(names) || names.length === 0) return null;
  const last = names[names.length - 1];
  return typeof last === "string" ? last : null;
}

/** Every SELECT_NODE in the tree, so subqueries and CTEs are covered too. */
function selectNodes(root: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(root)) {
    for (const item of root) selectNodes(item, out);
    return out;
  }
  if (!isObject(root)) return out;
  if (root.type === "SELECT_NODE") out.push(root);
  for (const value of Object.values(root)) selectNodes(value, out);
  return out;
}

/**
 * Resolve an ORDER BY term to the expression it actually sorts on.
 *
 * - `ORDER BY 2`  → the second select-list entry.
 * - `ORDER BY v`  → the entry aliased `v`, if one exists.
 * - anything else → itself.
 */
function resolveOrderTerm(
  expr: Expr | null,
  selectList: unknown[],
): Expr | null {
  if (!expr) return null;

  if (expr.class === "CONSTANT") {
    const raw = (expr as ConstantRef).value?.value;
    const ordinal = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > selectList.length) {
      return null;
    }
    return asExpr(selectList[ordinal - 1]);
  }

  const name = columnName(expr);
  if (name === null) return expr;

  for (const entry of selectList) {
    const candidate = asExpr(entry);
    if (candidate?.alias && candidate.alias.toLowerCase() === name.toLowerCase()) {
      return candidate;
    }
  }
  return expr;
}

function orderModifiers(node: Record<string, unknown>): unknown[] {
  const modifiers = node.modifiers;
  if (!Array.isArray(modifiers)) return [];
  const out: unknown[] = [];
  for (const modifier of modifiers) {
    if (isObject(modifier) && modifier.type === "ORDER_MODIFIER" && Array.isArray(modifier.orders)) {
      out.push(...modifier.orders);
    }
  }
  return out;
}

/**
 * Inspect a parsed statement set. Returns the first problem found, or null.
 *
 * `serialized` is the parsed output of `json_serialize_sql`; keeping this
 * function pure makes the whole policy testable without a DuckDB instance.
 */
export function inspectSerializedSql(
  serialized: SerializedSql,
  opts: { label: string; rawAmountColumns?: string[] },
): SqlIssue | null {
  const { label } = opts;

  if (serialized.error === true) {
    const detail = serialized.error_message ?? "could not be parsed";
    // DuckDB uses this exact message for every non-SELECT statement.
    if (detail.includes("Only SELECT statements")) {
      return {
        code: "policy_refused",
        message: `${label} must be a single SELECT statement; statements that read or write outside the snapshot are refused`,
      };
    }
    return { code: "validation", message: `${label} failed to parse: ${detail}` };
  }

  const statements = serialized.statements;
  if (!Array.isArray(statements) || statements.length === 0) {
    return { code: "validation", message: `${label} contains no statement` };
  }
  if (statements.length > 1) {
    return {
      code: "policy_refused",
      message: `${label} contains ${statements.length} statements; exactly one SELECT is allowed`,
    };
  }

  const rawColumns = new Set(
    (opts.rawAmountColumns ?? []).map((name) => name.toLowerCase()),
  );
  if (rawColumns.size === 0) return null;

  for (const node of selectNodes(statements[0])) {
    const selectList = Array.isArray(node.select_list) ? node.select_list : [];
    for (const order of orderModifiers(node)) {
      const term = isObject(order) ? asExpr(order.expression) : null;
      const resolved = resolveOrderTerm(term, selectList);
      const name = columnName(resolved);
      if (name !== null && rawColumns.has(name.toLowerCase())) {
        return {
          code: "validation",
          message:
            `${label}: ORDER BY ${name} would sort the raw amount as text ` +
            `("9" after "10"). Use ORDER BY cp_sortkey(${name}) for numeric order.`,
        };
      }
    }
  }

  return null;
}
