/**
 * Limits that more than one command has to agree on.
 *
 * The row limit lived as four separate copies of `10_000`, with nothing
 * keeping them in step — a caller could raise one and leave the others behind.
 */
import type { ProjectDocument } from "./types.js";

/**
 * Rows a single query may return.
 *
 * This bounds the viewer, not the pipeline: results are embedded in the
 * release and the table renders every row into the DOM. Going over is a typed
 * refusal, never a silent truncation.
 */
export const DEFAULT_ROW_LIMIT = 10_000;

export function rowLimitFor(project: Pick<ProjectDocument, "policy">): number {
  return project.policy?.row_limit ?? DEFAULT_ROW_LIMIT;
}
