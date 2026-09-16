import { Client } from "pg";
import type { BoundedJob, IngestAdapter, RunHandle, RunOptions } from "../adapter.js";
import { inspectCoverage } from "./inspectCoverage.js";
import { renderConfig } from "./renderConfig.js";
import { runBounded, stopAndQuiesce } from "./runBounded.js";
import { errorMessage } from "../../plan/errors.js";

export function rindexerAdapter(): IngestAdapter {
  return {
    renderConfig: (job: BoundedJob) => renderConfig(job),
    runBounded: (job: BoundedJob, opts: RunOptions) => runBounded(job, opts),
    stopAndQuiesce: (handle: RunHandle) => stopAndQuiesce(handle),
    inspectCoverage: async (job: BoundedJob) => {
      const client = new Client({ connectionString: job.databaseUrl });
      try {
        await client.connect();
      } catch (err) {
        throw Object.assign(
          new Error(
            `cannot reach postgres for coverage inspection: ${errorMessage(err)}`,
          ),
          { retryable: true },
        );
      }
      try {
        return await inspectCoverage(job, client);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
