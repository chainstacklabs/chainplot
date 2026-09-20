import { describe, expect, it } from "vitest";
import { inspectSerializedSql } from "../../src/query/sqlGuard.js";

// These exercise the policy against hand-written ASTs, so they run without a
// DuckDB instance. tests/query/models.test.ts covers the same policy against
// DuckDB's real parser output.

function columnRef(name: string, alias = ""): unknown {
  return { class: "COLUMN_REF", alias, column_names: [name] };
}

function selectNode(
  selectList: unknown[],
  orders: unknown[] = [],
): Record<string, unknown> {
  return {
    node: {
      type: "SELECT_NODE",
      select_list: selectList,
      modifiers: orders.length
        ? [{ type: "ORDER_MODIFIER", orders: orders.map((e) => ({ expression: e })) }]
        : [],
    },
  };
}

describe("sql admission control", () => {
  it("accepts a plain SELECT", () => {
    expect(
      inspectSerializedSql({ error: false, statements: [selectNode([columnRef("a")])] }, {
        label: "query",
      }),
    ).toBeNull();
  });

  it("refuses a non-SELECT statement as policy, not malformed input", () => {
    const issue = inspectSerializedSql(
      { error: true, error_message: "Only SELECT statements can be serialized to json!" },
      { label: "model m" },
    );
    expect(issue?.code).toBe("policy_refused");
    expect(issue?.message).toContain("model m");
  });

  it("reports a genuine syntax error as validation", () => {
    const issue = inspectSerializedSql(
      { error: true, error_message: 'syntax error at or near "where"' },
      { label: "query" },
    );
    expect(issue?.code).toBe("validation");
  });

  it("refuses more than one statement", () => {
    const issue = inspectSerializedSql(
      { error: false, statements: [selectNode([]), selectNode([])] },
      { label: "query" },
    );
    expect(issue?.code).toBe("policy_refused");
    expect(issue?.message).toMatch(/2 statements/);
  });

  it("refuses no statement at all", () => {
    expect(
      inspectSerializedSql({ error: false, statements: [] }, { label: "query" })?.code,
    ).toBe("validation");
  });

  describe("raw amount ordering", () => {
    const raw = { label: "query", rawAmountColumns: ["value"] };

    it("refuses a bare raw column", () => {
      const ast = selectNode([columnRef("value")], [columnRef("value")]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)?.code).toBe("validation");
    });

    it("refuses through a select-list alias", () => {
      const ast = selectNode([columnRef("value", "v")], [columnRef("v")]);
      const issue = inspectSerializedSql({ statements: [ast] }, raw);
      expect(issue?.code).toBe("validation");
      expect(issue?.message).toContain("cp_sortkey(value)");
    });

    it("refuses through a positional ordinal", () => {
      const ast = selectNode(
        [columnRef("tx_hash"), columnRef("value")],
        [{ class: "CONSTANT", value: { value: 2 } }],
      );
      expect(inspectSerializedSql({ statements: [ast] }, raw)?.code).toBe("validation");
    });

    it("refuses a qualified reference", () => {
      const ast = selectNode(
        [columnRef("value")],
        [{ class: "COLUMN_REF", column_names: ["t", "value"] }],
      );
      expect(inspectSerializedSql({ statements: [ast] }, raw)?.code).toBe("validation");
    });

    it("refuses inside a subquery", () => {
      const inner = selectNode([columnRef("value")], [columnRef("value")]).node;
      const outer = { node: { type: "SELECT_NODE", select_list: [columnRef("a")], modifiers: [], from_table: inner } };
      expect(inspectSerializedSql({ statements: [outer] }, raw)?.code).toBe("validation");
    });

    it("allows an expression over the raw column", () => {
      const sortKey = { class: "FUNCTION", function_name: "cp_sortkey", children: [columnRef("value")] };
      const ast = selectNode([columnRef("value")], [sortKey]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)).toBeNull();
    });

    it("allows an alias bound to an expression", () => {
      const sortKey = {
        class: "FUNCTION",
        alias: "k",
        function_name: "cp_sortkey",
        children: [columnRef("value")],
      };
      const ast = selectNode([columnRef("value"), sortKey], [columnRef("k")]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)).toBeNull();
    });

    it("allows ordering a column that is not a raw amount", () => {
      const ast = selectNode([columnRef("value")], [columnRef("block_number")]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)).toBeNull();
    });

    it("ignores an out-of-range ordinal rather than throwing", () => {
      const ast = selectNode([columnRef("value")], [{ class: "CONSTANT", value: { value: 9 } }]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)).toBeNull();
    });

    it("matches column names case-insensitively", () => {
      const ast = selectNode([columnRef("VALUE")], [columnRef("VALUE")]);
      expect(inspectSerializedSql({ statements: [ast] }, raw)?.code).toBe("validation");
    });
  });
});
