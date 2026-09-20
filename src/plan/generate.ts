import fs from "node:fs";
import path from "node:path";
import type { RpcClient } from "../rpc/client.js";
import { getFinalizedHead } from "../rpc/heads.js";
import type { ChainSource, EventSource, ProjectDocument } from "../project/types.js";
import {
  lastProvenCompleteBlock,
  requiredEnd,
} from "../ingest/coverage.js";
import {
  readCoverageFile,
  segmentsFor,
} from "../ingest/coverageStore.js";
import { sha256Hex, canonicalJson } from "./digest.js";
import { commandError } from "./errors.js";

export interface PlanSource {
  source_id: string;
  end_mode: "pinned" | "follow_finalized";
  job_start: number;
  job_end: number;
  job_target_end: number;
  required_end: number | null;
  blocks_remaining: number;
}

export interface PlanDocument {
  schema_version: 1;
  plan_id?: string;
  intent: "ingest" | "refresh" | "build" | "publish";
  project_id: string;
  project_digest: string;
  created_at: string;
  chain: { chain_id: number; finality: ChainSource["finality"] } | null;
  sources: PlanSource[];
  actions: Array<
    | { type: "ingest"; source_id: string }
    | { type: "export"; source_id: string }
    | { type: "build_results" }
    | { type: "publish"; target_id: string }
  >;
  limits: { block_budget: number };
  deletes_data: boolean;
  makes_data_public: boolean;
  state_assumptions: {
    sources: Record<string, { last_proven_complete_block: number }>;
  };
  publish_target: string | null;
  /**
   * content_digest of the built release this publish would upload.
   *
   * The plan digest otherwise covers only the project files, so rebuilding a
   * release with different content produced an identical plan: `apply` then
   * reused the previous run and uploaded nothing while reporting success.
   */
  release_digest?: string | null;
}

export interface GeneratePlanOptions {
  intent: "ingest" | "refresh" | "build" | "publish";
  cwd: string;
  project: ProjectDocument;
  rpcClient: RpcClient;
  now?: () => Date;
  publishTargetId?: string;
}

const DEFAULT_BLOCK_BUDGET = 100_000;

export function projectDigest(cwd: string): string {
  return sha256Hex(fs.readFileSync(path.join(cwd, "chainplot.yaml"), "utf8"));
}

export async function generatePlan(
  opts: GeneratePlanOptions,
): Promise<{ plan: PlanDocument; planPath: string }> {
  const { cwd, project, intent } = opts;
  const chain = project.chain_sources?.[0];
  const eventSources = project.event_sources ?? [];
  if (intent !== "build" && intent !== "publish") {
    if (!chain) throw commandError("validation", "project has no chain_sources");
    if (eventSources.length === 0) {
      throw commandError("validation", "project has no event_sources");
    }
  }

  const blockBudget = project.policy?.block_budget ?? DEFAULT_BLOCK_BUDGET;
  const coverage = readCoverageFile(cwd);
  const isBuild = intent === "build";

  // Credentials are required only when work needs them (spec §11: a refresh
  // that performs no ingest performs no RPC; a build plan performs neither).
  const needsHead =
    (intent === "ingest" || intent === "refresh") &&
    !!chain &&
    needsFinalizedProbe(eventSources, coverage);
  if (needsHead && chain && !process.env[chain.rpc_secret]) {
    throw commandError(
      "missing_credentials",
      `secret reference ${chain.rpc_secret} is not set in the environment`,
      { resource_id: chain.rpc_secret },
    );
  }

  // One finalized-head probe only when some source still needs ingest.
  const finalizedHead = needsHead
    ? (await getFinalizedHead(opts.rpcClient)).number
    : null;

  const planSources: PlanSource[] = [];
  const actions: PlanDocument["actions"] = [];
  const ingesting: string[] = [];
  const stateAssumptions: PlanDocument["state_assumptions"]["sources"] = {};

  for (const source of eventSources) {
    const segments = segmentsFor(coverage, source.id);
    const proven = lastProvenCompleteBlock(segments, source.start_block);
    stateAssumptions[source.id] = { last_proven_complete_block: proven };

    let jobTargetEnd: number;
    if (isBuild) {
      // Build plans never ingest; bounds are informational no-ops.
      jobTargetEnd = proven;
    } else if (source.end.mode === "pinned") {
      jobTargetEnd = source.end.block;
      if ((intent === "ingest" || intent === "refresh") && proven < jobTargetEnd && chain) {
        assertPinnedSatisfiesFinality(
          source as EventSource & { end: { mode: "pinned"; block: number } },
          chain,
          finalizedHead,
        );
      }
    } else {
      if (!chain || chain.finality.policy !== "finalized") {
        throw commandError(
          "unsupported_capability",
          "follow_finalized requires chain finality policy finalized",
          { resource_id: source.id, pointer: "/event_sources/end" },
        );
      }
      if (finalizedHead === null) {
        throw commandError(
          "transient_dependency",
          "cannot resolve finalized head for follow_finalized source",
          { resource_id: source.id, retryable: true },
        );
      }
      jobTargetEnd = finalizedHead;
      if (jobTargetEnd < source.start_block) {
        throw commandError(
          "policy_refused",
          `resolved_safe_end ${jobTargetEnd} is below start_block ${source.start_block}`,
          { resource_id: source.id, pointer: "/event_sources/start_block" },
        );
      }
    }

    const jobStart = proven + 1;
    const jobEnd = Math.min(jobTargetEnd, jobStart + blockBudget - 1);
    planSources.push({
      source_id: source.id,
      end_mode: source.end.mode,
      job_start: jobStart,
      job_end: jobStart <= jobEnd ? jobEnd : jobStart - 1,
      job_target_end: jobTargetEnd,
      required_end: requiredEnd(source.end, segments),
      blocks_remaining: Math.max(0, jobTargetEnd - proven),
    });
    // Only ingest plans ingest; refresh ingests only follow_finalized sources
    // (pinned skips on refresh, spec §9.2); build/publish never ingest.
    const skipIngest =
      intent === "build" ||
      intent === "publish" ||
      (intent === "refresh" && source.end.mode === "pinned");
    if (jobStart <= jobEnd && !skipIngest) {
      ingesting.push(source.id);
    }
  }

  // A backfill wider than the block budget takes several runs. Only the run
  // that closes the range exports and builds: the promotion gate refuses
  // anything short of complete coverage, so an intermediate run that also
  // tried would ingest correctly and then fail, reporting the whole run as
  // failed. Intermediate runs ingest and stop.
  const closesRange = planSources.every((s) => s.job_end >= s.job_target_end);
  for (const sourceId of ingesting) {
    actions.push({ type: "ingest", source_id: sourceId });
    if (closesRange) actions.push({ type: "export", source_id: sourceId });
  }

  if (actions.some((a) => a.type === "ingest") && !process.env.DATABASE_URL) {
    throw commandError("missing_credentials", "DATABASE_URL is not set", {
      resource_id: "DATABASE_URL",
    });
  }

  // Publish plans are publication-only (spec §8): they never rebuild.
  //
  // A backfill that the block budget splits across several runs must not
  // promise a build it already knows the promotion gate will refuse: the
  // ingest would succeed, the build would fail, and `apply` would report the
  // whole run as failed with the coverage it just proved discarded from view.
  // Intermediate plans therefore ingest and export only; the plan that closes
  // the range carries the build. A `build` intent always builds — an explicit
  // request deserves the gate's own error, not a silently empty plan.
  if (
    project.queries?.length &&
    intent !== "publish" &&
    (ingesting.length === 0 || closesRange)
  ) {
    actions.push({ type: "build_results" });
  }

  let publishTarget: string | null = null;
  if (intent === "publish") {
    const targets = project.publish_targets ?? [];
    if (targets.length === 0) {
      throw commandError(
        "policy_refused",
        "publish intent requires a publish target in chainplot.yaml",
        { pointer: "/publish_targets" },
      );
    }
    const target = opts.publishTargetId
      ? targets.find((t) => t.id === opts.publishTargetId)
      : targets[0];
    if (!target) {
      throw commandError(
        "policy_refused",
        `publish target ${opts.publishTargetId} is not in chainplot.yaml`,
        { pointer: "/publish_targets" },
      );
    }
    actions.push({ type: "publish", target_id: target.id });
    publishTarget = target.id;
  }

  const plan: PlanDocument = {
    schema_version: 1,
    intent,
    project_id: project.id,
    project_digest: projectDigest(cwd),
    created_at: (opts.now ?? (() => new Date()))().toISOString(),
    chain: chain
      ? { chain_id: chain.chain_id, finality: chain.finality }
      : null,
    sources: planSources,
    actions,
    limits: { block_budget: blockBudget },
    deletes_data: false,
    makes_data_public: intent === "publish",
    state_assumptions: { sources: stateAssumptions },
    publish_target: publishTarget,
    release_digest: intent === "publish" ? builtReleaseDigest(cwd) : null,
  };
  plan.plan_id = sha256Hex(
    canonicalJson({ ...plan, plan_id: undefined, created_at: undefined }),
  );

  const plansDir = path.join(cwd, ".chainplot", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, `${plan.plan_id}.json`);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, planPath };
}

/** content_digest of the release sitting in dist/releases/local, if any. */
function builtReleaseDigest(cwd: string): string | null {
  const releaseJson = path.join(cwd, "dist", "releases", "local", "release.json");
  if (!fs.existsSync(releaseJson)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(releaseJson, "utf8")) as {
      content_digest?: string;
    };
    return doc.content_digest ?? null;
  } catch {
    return null;
  }
}

function pinnedEnd(source: EventSource): number {
  return source.end.mode === "pinned" ? source.end.block : Number.MAX_SAFE_INTEGER;
}

function provenFor(source: EventSource, coverage: ReturnType<typeof readCoverageFile>): number {
  return lastProvenCompleteBlock(segmentsFor(coverage, source.id), source.start_block);
}

function needsFinalizedProbe(
  sources: EventSource[],
  coverage: ReturnType<typeof readCoverageFile>,
): boolean {
  if (sources.some((s) => s.end.mode === "follow_finalized")) return true;
  return sources.some(
    (s) => s.end.mode === "pinned" && provenFor(s, coverage) < s.end.block,
  );
}

function assertPinnedSatisfiesFinality(
  source: EventSource & { end: { mode: "pinned"; block: number } },
  chain: ChainSource,
  finalizedHead: number | null,
): void {
  if (finalizedHead === null) {
    throw commandError(
      "transient_dependency",
      "cannot verify pinned end_block against the chain head",
      { resource_id: source.id, retryable: true },
    );
  }
  if (chain.finality.policy === "finalized") {
    if (source.end.block > finalizedHead) {
      throw commandError(
        "policy_refused",
        `pinned end_block ${source.end.block} is above finalized head ${finalizedHead}; pinning into the unfinalized zone is refused`,
        {
          resource_id: source.id,
          pointer: "/event_sources/end",
          suggested_next: "set end_block to a block at or below the finalized head",
        },
      );
    }
    return;
  }
  const limit = finalizedHead - chain.finality.depth;
  if (source.end.block > limit) {
    throw commandError(
      "policy_refused",
      `pinned end_block ${source.end.block} does not satisfy confirmation_depth ${chain.finality.depth} (limit ${limit})`,
      { resource_id: source.id, pointer: "/event_sources/end" },
    );
  }
}
