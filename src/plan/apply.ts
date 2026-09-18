import fs from "node:fs";
import path from "node:path";
import type { RpcClient } from "../rpc/client.js";
import { getHeader } from "../rpc/heads.js";
import type { BoundedJob, IngestAdapter } from "../ingest/adapter.js";
import type { ExportResult } from "../ingest/exporter.js";
import { exportEventTable } from "../ingest/exporter.js";
import {
  appendSegment,
  readCoverageFile,
  segmentsFor,
  writeCoverageFile,
} from "../ingest/coverageStore.js";
import { hashJoinOk, isComplete, lastProvenCompleteBlock } from "../ingest/coverage.js";
import { loadProject } from "../project/load.js";
import { validateProject } from "../project/validate.js";
import type { EventSource, ProjectDocument } from "../project/types.js";
import {
  appendCheckpoint,
  readJournalPlan,
  readJournalStatus,
  writeJournalPlan,
  writeJournalProject,
  writeJournalStatus,
} from "../runtime/journal.js";
import { acquireLocalLock } from "../runtime/locks.js";
import {
  publishRelease,
  publishedReleaseIntact,
  type PublishResult,
} from "../publish/publishRelease.js";
import { commandError, errorMessage } from "./errors.js";
import { projectDigest, type PlanDocument } from "./generate.js";

export interface ApplyOptions {
  cwd: string;
  planRef: string; // path or plan id
  idempotencyKey?: string;
  adapter: IngestAdapter;
  exportFn?: (job: BoundedJob, outDir: string) => Promise<ExportResult>;
  buildFn?: (cwd: string) => Promise<{ distDir: string }>;
  rindexerBin: string;
  wallClockMs?: number;
  rpcClient: RpcClient;
  onProgress?: (event: {
    run_id: string;
    stage: string;
    message?: string;
    rows?: number;
  }) => void;
}

export interface ApplyOutcome {
  plan_id: string;
  idempotency_key: string;
  status: "succeeded" | "canceled";
  reused: boolean;
  release_dir: string | null;
  publish: PublishResult | null;
}

const DEFAULT_WALL_CLOCK_MS = 30 * 60 * 1000;

function resolvePlanFile(cwd: string, planRef: string): string {
  return planRef.endsWith(".json")
    ? path.resolve(cwd, planRef)
    : path.join(cwd, ".chainplot", "plans", `${planRef}.json`);
}

function cancelRequested(cwd: string, key: string): boolean {
  return fs.existsSync(
    path.join(cwd, ".chainplot", "runs", key, "cancel_requested"),
  );
}

function assertNotCanceled(cwd: string, key: string): void {
  if (cancelRequested(cwd, key)) {
    writeJournalStatus(cwd, key, {
      status: "canceled",
      plan_id: key,
      plan_digest: key,
    });
    throw commandError("policy_refused", `run ${key} canceled`, { resource_id: key });
  }
}

export async function applyPlan(opts: ApplyOptions): Promise<ApplyOutcome> {
  const planPath = resolvePlanFile(opts.cwd, opts.planRef);
  if (!fs.existsSync(planPath)) {
    throw commandError("validation", `plan not found: ${opts.planRef}`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as PlanDocument;
  if (!plan.plan_id) {
    throw commandError("validation", `plan file has no plan_id: ${opts.planRef}`);
  }
  const key = opts.idempotencyKey ?? plan.plan_id;

  // Idempotency: same key + same digest → reuse outcome; different digest → refuse.
  const journalPlan = readJournalPlan<PlanDocument>(opts.cwd, key);
  if (journalPlan !== null && journalPlan.plan_id !== plan.plan_id) {
    throw commandError(
      "policy_refused",
      `idempotency key ${key} already used by a different plan digest`,
      {
        resource_id: key,
        suggested_next: "omit --idempotency-key to default to the plan digest",
      },
    );
  }
  const existingStatus = readJournalStatus(opts.cwd, key);
  if (existingStatus?.status === "succeeded") {
    const previous = existingStatus.result as
      | { release_dir?: string; publish?: PublishResult | null }
      | undefined;
    const published = previous?.publish ?? null;
    // A journaled publish is worth replaying only while what it published is
    // still there. Otherwise a bucket emptied since then gets "N files
    // uploaded" with nothing uploaded, for as long as the journal lives.
    if (published === null || (await publishStillThere(opts.cwd, published))) {
      return {
        plan_id: plan.plan_id,
        idempotency_key: key,
        status: "succeeded",
        reused: true,
        release_dir: previous?.release_dir ?? null,
        publish: published,
      };
    }
    appendCheckpoint(opts.cwd, key, {
      stage: "reuse_declined",
      release_prefix: published.release_prefix,
      message: "published release no longer present at the target",
    });
  }
  if (existingStatus?.status === "running") {
    throw commandError("policy_refused", `run ${key} is already running`, {
      resource_id: key,
    });
  }

  // Configuration drift: plan digest must match current chainplot.yaml.
  if (projectDigest(opts.cwd) !== plan.project_digest) {
    throw commandError(
      "policy_refused",
      "chainplot.yaml changed since this plan was written; write a new plan",
      { resource_id: plan.project_id, suggested_next: "plan --intent ingest" },
    );
  }

  const project = loadAndValidate(opts.cwd);
  assertStateAssumptionsHold(opts.cwd, plan, project);

  const lock = acquireLocalLock(opts.cwd, "ingest");
  const progress = (stage: string, extra: { message?: string; rows?: number } = {}) =>
    opts.onProgress?.({ run_id: key, stage, ...extra });
  try {
    writeJournalPlan(opts.cwd, key, plan);
    writeJournalProject(opts.cwd, key, project);
    writeJournalStatus(opts.cwd, key, {
      status: "running",
      plan_id: plan.plan_id,
      plan_digest: plan.plan_id,
    });
    progress("plan_verified");

    const chain = project.chain_sources?.[0];
    const rpcUrl = chain ? (process.env[chain.rpc_secret] ?? "") : "";
    const databaseUrl = process.env.DATABASE_URL ?? "";
    const sourceById = new Map((project.event_sources ?? []).map((s) => [s.id, s]));

    for (const action of plan.actions) {
      assertNotCanceled(opts.cwd, key);
      if (action.type !== "ingest") continue;
      const source = sourceById.get(action.source_id);
      if (!source) {
        throw commandError("validation", `unknown source ${action.source_id}`);
      }
      await runIngestAction(opts, plan, source, key, rpcUrl, databaseUrl, progress);
    }

    const hasBuildWork = plan.actions.some(
      (a) => a.type === "export" || a.type === "build_results",
    );
    const releaseDir = hasBuildWork
      ? await runExportAndBuild(opts, plan, sourceById, key, databaseUrl, progress)
      : (plan.publish_target !== null ? path.join(opts.cwd, "dist", "releases", "local") : null);

    let published: PublishResult | null = null;
    for (const action of plan.actions) {
      assertNotCanceled(opts.cwd, key);
      if (action.type !== "publish") continue;
      const targetDoc = (project.publish_targets ?? []).find(
        (t) => t.id === action.target_id,
      );
      if (!targetDoc) {
        throw commandError(
          "validation",
          `unknown publish target ${action.target_id}`,
        );
      }
      published = await publishRelease(opts.cwd, targetDoc);
      appendCheckpoint(opts.cwd, key, {
        stage: "published",
        target_id: published.target_id,
        release_prefix: published.release_prefix,
      });
    }

    writeJournalStatus(opts.cwd, key, {
      status: "succeeded",
      plan_id: plan.plan_id,
      plan_digest: plan.plan_id,
      result: { release_dir: releaseDir, publish: published },
    });
    progress("release_written", { message: releaseDir ?? "" });
    return {
      plan_id: plan.plan_id,
      idempotency_key: key,
      status: "succeeded",
      reused: false,
      release_dir: releaseDir,
      publish: published,
    };
  } catch (err) {
    // A cancellation is not a failure. `assertNotCanceled` already recorded it
    // as canceled; overwriting that with "failed" made the `canceled` status
    // unreachable from the cooperative path, so `runs list` could never show
    // the one thing `runs cancel` exists to produce.
    writeJournalStatus(opts.cwd, key, {
      status: cancelRequested(opts.cwd, key) ? "canceled" : "failed",
      plan_id: plan.plan_id,
      plan_digest: plan.plan_id,
      result: { message: errorMessage(err) },
    });
    throw err;
  } finally {
    lock.release();
  }
}

async function publishStillThere(cwd: string, published: PublishResult): Promise<boolean> {
  const targetDoc = (loadAndValidate(cwd).publish_targets ?? []).find(
    (t) => t.id === published.target_id,
  );
  if (!targetDoc) return false;
  return publishedReleaseIntact(cwd, targetDoc, published.release_prefix);
}

function loadAndValidate(cwd: string): ProjectDocument {
  const doc = loadProject(cwd);
  const validated = validateProject(doc, cwd);
  if (!validated.ok) throw validated.error;
  return validated.project;
}

function assertStateAssumptionsHold(
  cwd: string,
  plan: PlanDocument,
  project: ProjectDocument,
): void {
  const coverage = readCoverageFile(cwd);
  for (const source of project.event_sources ?? []) {
    const assumption = plan.state_assumptions.sources[source.id];
    if (!assumption) continue;
    const proven = lastProvenCompleteBlock(
      segmentsFor(coverage, source.id),
      source.start_block,
    );
    if (proven !== assumption.last_proven_complete_block) {
      throw commandError(
        "policy_refused",
        `coverage for ${source.id} changed since the plan was written (assumed ${assumption.last_proven_complete_block}, now ${proven}); re-plan`,
        { resource_id: source.id, suggested_next: "plan --intent ingest" },
      );
    }
  }
}

async function runIngestAction(
  opts: ApplyOptions,
  plan: PlanDocument,
  source: EventSource,
  key: string,
  rpcUrl: string,
  databaseUrl: string,
  progress: (stage: string, extra?: { message?: string; rows?: number }) => void,
): Promise<void> {
  const planSource = plan.sources.find((s) => s.source_id === source.id);
  if (!planSource) {
    throw commandError("validation", `plan has no bounds for ${source.id}`);
  }
  const job: BoundedJob = {
    sourceId: source.id,
    contractName: source.id.toLowerCase(),
    networkName: `chainplot_${plan.chain?.chain_id ?? 0}`,
    chainId: plan.chain?.chain_id ?? 0,
    addresses: source.addresses,
    abiPath: path.resolve(opts.cwd, source.abi),
    events: source.events,
    indexedFilters: source.indexed_filters,
    jobStart: planSource.job_start,
    jobEnd: planSource.job_end,
    rpcUrl,
    databaseUrl,
    workDir: path.join(opts.cwd, ".chainplot", "ingest", source.id),
  };

  progress("ingest_started", { message: source.id });
  const handle = await opts.adapter.runBounded(job, {
    rindexerBin: opts.rindexerBin,
    wallClockMs: opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
  });
  await opts.adapter.stopAndQuiesce(handle);
  progress("ingest_completed", { message: source.id });
  let report = await opts.adapter.inspectCoverage(job);
  if (report.status === "complete_empty") {
    // rindexer commits the sync cursor before its final event-row flush; a
    // complete_empty read immediately after SIGTERM can be a flush race.
    // Re-inspect after a settle window; genuinely empty ranges stay empty (A6).
    await new Promise((r) => setTimeout(r, 3_000));
    const second = await opts.adapter.inspectCoverage(job);
    if (second.rowCount > report.rowCount) report = second;
  }
  if (report.status !== "complete_empty" && report.status !== "complete_with_rows") {
    throw commandError(
      "transient_dependency",
      `ingest for ${source.id} did not prove coverage: ${report.status} (last_synced_block=${report.lastSyncedBlock}, job_end=${job.jobEnd})`,
      {
        resource_id: source.id,
        retryable: true,
        suggested_next: "apply the same plan again to resume",
      },
    );
  }

  const parent = await getHeader(opts.rpcClient, job.jobStart - 1);
  const start = await getHeader(opts.rpcClient, job.jobStart);
  const end = await getHeader(opts.rpcClient, job.jobEnd);

  const segment = {
    start_block: job.jobStart,
    end_block: job.jobEnd,
    start_block_hash: start.hash,
    end_block_hash: end.hash,
    start_block_parent_hash: parent.hash,
    status: report.status,
    row_count: report.rowCount,
    end_block_timestamp: end.timestamp,
    indexed_at: new Date().toISOString(),
  };
  const coverage = readCoverageFile(opts.cwd);
  // The coverage file is the proof; it has to say which chain it proves.
  coverage.chain_id = plan.chain?.chain_id ?? coverage.chain_id;
  const tail = segmentsFor(coverage, source.id).at(-1);
  if (tail && !hashJoinOk(tail, segment)) {
    throw commandError(
      "source_inconsistent",
      `new segment for ${source.id} does not hash-join the previous segment (possible reorg); coverage unchanged`,
      { resource_id: source.id },
    );
  }
  writeCoverageFile(opts.cwd, appendSegment(coverage, source.id, segment));
  progress("coverage_recorded", {
    message: source.id,
    rows: report.rowCount,
  });
  appendCheckpoint(opts.cwd, key, {
    stage: "coverage_recorded",
    source_id: source.id,
    start_block: segment.start_block,
    end_block: segment.end_block,
    status: segment.status,
  });
}

async function runExportAndBuild(
  opts: ApplyOptions,
  plan: PlanDocument,
  sourceById: Map<string, EventSource>,
  key: string,
  databaseUrl: string,
  progress: (stage: string, extra?: { message?: string; rows?: number }) => void,
): Promise<string> {
  const coverage = readCoverageFile(opts.cwd);

  // Promotion gate: every source must be complete over [start_block, required_end].
  for (const source of sourceById.values()) {
    assertNotCanceled(opts.cwd, key);
    const verdict = isComplete(
      segmentsFor(coverage, source.id),
      source.start_block,
      source.end,
    );
    if (!verdict.complete) {
      throw commandError(
        "policy_refused",
        `source ${source.id} is incomplete (${verdict.reason ?? "unknown"}); incomplete data cannot be promoted`,
        { resource_id: source.id, suggested_next: "plan --intent ingest to continue" },
      );
    }
  }

  for (const action of plan.actions) {
    if (action.type !== "export") continue;
    const source = sourceById.get(action.source_id);
    if (!source) continue;
    // One parquet per (source, event): dataset snapshots map 1:1 to events.
    for (const event of source.events) {
      const job: BoundedJob = {
        sourceId: source.id,
        contractName: source.id.toLowerCase(),
        networkName: `chainplot_${plan.chain?.chain_id ?? 0}`,
        chainId: plan.chain?.chain_id ?? 0,
        addresses: source.addresses,
        abiPath: path.resolve(opts.cwd, source.abi),
        events: [event],
        jobStart: 0,
        jobEnd: 0,
        rpcUrl: "",
        databaseUrl,
        workDir: path.join(opts.cwd, ".chainplot", "ingest", source.id),
      };
      const outDir = path.join(opts.cwd, ".chainplot", "snapshots", source.id);
      const exportFn = opts.exportFn ?? exportEventTable;
      const result = await exportFn(job, outDir);
      progress("export_completed", {
        message: `${source.id}.${event}`,
        rows: result.rowCount,
      });
      appendCheckpoint(opts.cwd, key, {
        stage: "export_completed",
        source_id: source.id,
        event,
        rows: result.rowCount,
        parquet: result.parquetPath,
      });
    }
  }

  const buildFn =
    opts.buildFn ??
    ((c: string) =>
      import("../publish/writeRelease.js").then((m) => m.buildRelease(c)));
  const release = await buildFn(opts.cwd);
  return release.distDir;
}
