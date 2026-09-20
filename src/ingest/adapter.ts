import { RpcError } from "../rpc/client.js";

export type CoverageStatus =
  | "not_indexed"
  | "incomplete"
  | "complete_empty"
  | "complete_with_rows";

export interface IndexedFilterSpec {
  event_name: string;
  indexed_1?: string[];
  indexed_2?: string[];
  indexed_3?: string[];
}

export interface BoundedJob {
  sourceId: string;
  contractName: string;
  networkName: string;
  chainId: number;
  addresses: string[];
  abiPath: string;
  events: string[];
  jobStart: number;
  jobEnd: number;
  rpcUrl: string;
  databaseUrl: string;
  workDir: string;
  indexedFilters?: IndexedFilterSpec[];
}

const IDENTIFIER = /^[a-z0-9_]+$/;

export function assertValidJobIdentifiers(job: BoundedJob): void {
  for (const [name, value] of [
    ["contractName", job.contractName],
    ["networkName", job.networkName],
  ] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new RpcError(
        false,
        `invalid ${name} identifier: ${JSON.stringify(value)}`,
      );
    }
  }
}

export interface RunOptions {
  rindexerBin: string;
  wallClockMs: number;
}

export interface RunHandle {
  job: BoundedJob;
  pid: number;
  completedLogSeen: boolean;
}

export interface CoverageReport {
  status: CoverageStatus;
  lastSyncedBlock: number | null;
  rowCount: number;
}

export interface IngestAdapter {
  renderConfig(job: BoundedJob): string;
  runBounded(job: BoundedJob, opts: RunOptions): Promise<RunHandle>;
  stopAndQuiesce(handle: RunHandle): Promise<void>;
  inspectCoverage(job: BoundedJob): Promise<CoverageReport>;
}
