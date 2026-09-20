import type { PoolClient } from "pg";
import {
  assertValidJobIdentifiers,
  type BoundedJob,
  type CoverageReport,
  type CoverageStatus,
} from "../adapter.js";

// Table names are derived in naming.ts, which ports rindexer's own snake_case
// rule; re-exported here because this is where callers look for them.
export {
  cursorTableName,
  eventTableName,
  manifestName,
} from "./naming.js";
import { cursorTableName, eventTableName } from "./naming.js";

export function buildCursorQuery(
  networkName: string,
  contractName: string,
  event: string,
): { text: string; params: string[] } {
  return {
    text: `SELECT last_synced_block FROM ${cursorTableName(networkName, contractName, event)} WHERE network = $1`,
    params: [networkName],
  };
}

export function buildRowCountQuery(
  networkName: string,
  contractName: string,
  event: string,
): string {
  return `SELECT count(*)::bigint AS n FROM ${eventTableName(networkName, contractName, event)}`;
}

export function classifyCoverage(
  lastSyncedBlock: number | null,
  rowCount: number,
  jobEnd: number,
): CoverageReport {
  const status: CoverageStatus =
    lastSyncedBlock === null
      ? "not_indexed"
      : lastSyncedBlock < jobEnd
        ? "incomplete"
        : rowCount === 0
          ? "complete_empty"
          : "complete_with_rows";
  return { status, lastSyncedBlock, rowCount };
}

export async function inspectCoverage(
  job: BoundedJob,
  client: Pick<PoolClient, "query">,
): Promise<CoverageReport> {
  assertValidJobIdentifiers(job);
  // Every declared event must prove coverage; the aggregate is the worst
  // per-event status and the summed row count.
  const statuses: CoverageStatus[] = [];
  let minCursor: number | null = null;
  let totalRows = 0;
  for (const event of job.events) {
    const cursor = await client.query<{ last_synced_block: string }>(
      buildCursorQuery(job.networkName, job.contractName, event).text,
      [job.networkName],
    );
    const lastSyncedBlock =
      cursor.rows.length === 0
        ? null
        : Number(BigInt(cursor.rows[0].last_synced_block));
    const countResult = await client.query<{ n: string }>(
      buildRowCountQuery(job.networkName, job.contractName, event),
    );
    const rowCount = Number(countResult.rows[0]?.n ?? 0);
    statuses.push(classifyCoverage(lastSyncedBlock, rowCount, job.jobEnd).status);
    totalRows += rowCount;
    if (lastSyncedBlock !== null) {
      minCursor =
        minCursor === null
          ? lastSyncedBlock
          : Math.min(minCursor, lastSyncedBlock);
    }
  }
  const worst: CoverageStatus = statuses.includes("not_indexed")
    ? "not_indexed"
    : statuses.includes("incomplete")
      ? "incomplete"
      : statuses.includes("complete_with_rows")
        ? "complete_with_rows"
        : "complete_empty";
  return { status: worst, lastSyncedBlock: minCursor, rowCount: totalRows };
}

export { assertValidJobIdentifiers };
