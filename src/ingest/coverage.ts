import type { EventEnd } from "../project/types.js";

export interface CoverageSegment {
  start_block: number;
  end_block: number;
  start_block_hash: string;
  end_block_hash: string;
  start_block_parent_hash: string;
  status: "complete_empty" | "complete_with_rows";
  row_count?: number;
  /** Unix seconds of `end_block`. The chain's own clock, not the host's. */
  end_block_timestamp?: number;
  /** When this segment was proven, for "last checked" as distinct from "data through". */
  indexed_at?: string;
}

export interface SourceCoverage {
  source_id: string;
  segments: CoverageSegment[];
}

export interface CoverageFile {
  schema_version: 1;
  chain_id: number;
  sources: SourceCoverage[];
}

export function hashJoinOk(
  prev: CoverageSegment,
  next: CoverageSegment,
): boolean {
  return (
    next.start_block === prev.end_block + 1 &&
    next.start_block_parent_hash === prev.end_block_hash
  );
}

export function lastProvenCompleteBlock(
  segments: CoverageSegment[],
  projectStartBlock: number,
): number {
  let proven = projectStartBlock - 1;
  let prev: CoverageSegment | null = null;
  for (const segment of segments) {
    if (segment.start_block !== proven + 1) break;
    if (prev !== null && !hashJoinOk(prev, segment)) break;
    proven = segment.end_block;
    prev = segment;
  }
  return proven;
}

export function requiredEnd(
  end: EventEnd,
  segments: CoverageSegment[],
): number | null {
  if (end.mode === "pinned") return end.block;
  if (segments.length === 0) return null;
  return Math.max(...segments.map((s) => s.end_block));
}

export function isComplete(
  segments: CoverageSegment[],
  projectStartBlock: number,
  end: EventEnd,
): { complete: boolean; reason: string | null } {
  const target = requiredEnd(end, segments);
  if (target === null) return { complete: false, reason: "not_indexed" };
  let reached = projectStartBlock - 1;
  let prev: CoverageSegment | null = null;
  for (const segment of segments) {
    if (reached >= target) break;
    if (segment.start_block !== reached + 1) {
      return { complete: false, reason: "truncated" };
    }
    if (prev !== null && !hashJoinOk(prev, segment)) {
      return { complete: false, reason: "hash_join_broken" };
    }
    reached = segment.end_block;
    prev = segment;
  }
  if (reached < target) return { complete: false, reason: "truncated" };
  return { complete: true, reason: null };
}
