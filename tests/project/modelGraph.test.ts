import { describe, expect, it } from "vitest";
import { topoSortModels } from "../../src/project/modelGraph.js";
import type { ModelNode } from "../../src/project/modelGraph.js";

function m(id: string, depends_on: string[]): ModelNode {
  return { id, file: `models/${id}.sql`, depends_on };
}

describe("topoSortModels", () => {
  it("empty input → empty order", () => {
    expect(topoSortModels([])).toEqual([]);
  });

  it("linear chain → deps first", () => {
    const order = topoSortModels([m("c", ["b"]), m("a", []), m("b", ["a"])]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("diamond → shared dep once, before both dependents", () => {
    const order = topoSortModels([
      m("left", ["base"]),
      m("right", ["base"]),
      m("top", ["left", "right"]),
      m("base", []),
    ]);
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("left"));
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("right"));
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("top"));
    expect(order.indexOf("right")).toBeLessThan(order.indexOf("top"));
    expect(order).toHaveLength(4);
  });

  it("unknown dependency → validation error naming it", () => {
    expect(() => topoSortModels([m("a", ["ghost"])])).toThrowError(/ghost/);
    try {
      topoSortModels([m("a", ["ghost"])]);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("validation");
    }
  });

  it("self dependency → cycle", () => {
    expect(() => topoSortModels([m("a", ["a"])])).toThrowError(/cycle/i);
  });

  it("two-node cycle → cycle", () => {
    expect(() =>
      topoSortModels([m("a", ["b"]), m("b", ["a"])]),
    ).toThrowError(/cycle/i);
  });

  it("duplicate model ids → validation", () => {
    expect(() => topoSortModels([m("a", []), m("a", [])])).toThrowError(/a/);
  });
});
