import { describe, expect, it } from "vitest";
import {
  hashJoinOk,
  isComplete,
  lastProvenCompleteBlock,
  requiredEnd,
  type CoverageSegment,
} from "../../src/ingest/coverage.js";

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function seg(
  start: number,
  end: number,
  opts: {
    parent?: string;
    startHash?: string;
    endHash?: string;
    status?: "complete_empty" | "complete_with_rows";
  } = {},
): CoverageSegment {
  return {
    start_block: start,
    end_block: end,
    start_block_hash: opts.startHash ?? H(start),
    end_block_hash: opts.endHash ?? H(end),
    start_block_parent_hash: opts.parent ?? H(start - 1),
    status: opts.status ?? "complete_with_rows",
  };
}

describe("lastProvenCompleteBlock", () => {
  it("no segments → start_block - 1", () => {
    expect(lastProvenCompleteBlock([], 100)).toBe(99);
  });

  it("single segment starting at project start", () => {
    expect(lastProvenCompleteBlock([seg(100, 110)], 100)).toBe(110);
  });

  it("segment starting after project start (front gap) → start - 1", () => {
    expect(lastProvenCompleteBlock([seg(105, 110)], 100)).toBe(99);
  });

  it("two hash-joined segments → second end", () => {
    const a = seg(100, 110);
    const b = seg(111, 120, { parent: a.end_block_hash });
    expect(lastProvenCompleteBlock([a, b], 100)).toBe(120);
  });

  it("number-adjacent but parent mismatch → first end only", () => {
    const a = seg(100, 110);
    const b = seg(111, 120, { parent: H(999999) });
    expect(lastProvenCompleteBlock([a, b], 100)).toBe(110);
  });

  it("gap between segments → first end", () => {
    const a = seg(100, 110);
    const b = seg(115, 120, { parent: H(114) });
    expect(lastProvenCompleteBlock([a, b], 100)).toBe(110);
  });
});

describe("hashJoinOk", () => {
  it("requires number adjacency and parent link", () => {
    const a = seg(100, 110);
    expect(hashJoinOk(a, seg(111, 120, { parent: a.end_block_hash }))).toBe(
      true,
    );
    expect(hashJoinOk(a, seg(112, 120, { parent: a.end_block_hash }))).toBe(
      false,
    );
    expect(hashJoinOk(a, seg(111, 120, { parent: H(1) }))).toBe(false);
  });
});

describe("requiredEnd", () => {
  it("pinned → declared block", () => {
    expect(requiredEnd({ mode: "pinned", block: 200 }, [seg(100, 110)])).toBe(
      200,
    );
  });

  it("follow_finalized with no segments → null", () => {
    expect(requiredEnd({ mode: "follow_finalized" }, [])).toBeNull();
  });

  it("follow_finalized → max segment end", () => {
    const a = seg(100, 110);
    const b = seg(111, 150, { parent: a.end_block_hash });
    expect(requiredEnd({ mode: "follow_finalized" }, [a, b])).toBe(150);
  });
});

describe("isComplete", () => {
  it("pinned truncated → incomplete", () => {
    const result = isComplete([seg(100, 150)], 100, {
      mode: "pinned",
      block: 200,
    });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("truncated");
  });

  it("pinned covered → complete", () => {
    expect(
      isComplete([seg(100, 200)], 100, { mode: "pinned", block: 200 }).complete,
    ).toBe(true);
  });

  it("follow_finalized with no segments → not_indexed", () => {
    const result = isComplete([], 100, { mode: "follow_finalized" });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("not_indexed");
  });

  it("follow_finalized contiguous → complete", () => {
    const a = seg(100, 110);
    const b = seg(111, 150, { parent: a.end_block_hash });
    expect(
      isComplete([a, b], 100, { mode: "follow_finalized" }).complete,
    ).toBe(true);
  });

  it("front gap → incomplete", () => {
    const result = isComplete([seg(105, 200)], 100, {
      mode: "pinned",
      block: 200,
    });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("truncated");
  });

  it("hash-join break → incomplete with reason", () => {
    const a = seg(100, 110);
    const b = seg(111, 200, { parent: H(999999) });
    const result = isComplete([a, b], 100, { mode: "pinned", block: 200 });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("hash_join_broken");
  });
});
