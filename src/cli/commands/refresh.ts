import { failResult, okResult, type CommandResult } from "../envelope.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";
import { generatePlan } from "../../plan/generate.js";
import { applyPlan } from "../../plan/apply.js";
import { rindexerAdapter } from "../../ingest/rindexer/index.js";
import { createRpcClient } from "../../rpc/client.js";
import { lastSucceededRunKey, readJournalProject } from "../../runtime/journal.js";
import { publishRelease } from "../../publish/publishRelease.js";
import { isCommandError } from "./build.js";

function refused(message: string, suggestedNext: string | null = null) {
  return failResult("refresh", {
    code: "policy_refused",
    message,
    resource_id: null,
    pointer: null,
    retryable: false,
    suggested_next: suggestedNext,
  });
}

function ingestSignature(project: unknown): string {
  const p = project as {
    chain_sources?: unknown;
    event_sources?: unknown;
    publish_targets?: unknown;
  };
  return JSON.stringify([
    p.chain_sources ?? null,
    p.event_sources ?? null,
    p.publish_targets ?? null,
  ]);
}

export async function refreshCommand(
  cwd: string,
  publishTarget?: string,
  jsonl = false,
): Promise<CommandResult> {
  try {
    const doc = loadProject(cwd);
    const validated = validateProject(doc, cwd);
    if (!validated.ok) return failResult("refresh", validated.error);
    const project = validated.project;

    if (!project.chain_sources?.length || !project.event_sources?.length) {
      return refused(
        "refresh requires an ingest project (chain_sources + event_sources)",
        "use build for dataset-only projects",
      );
    }
    if (
      publishTarget !== undefined &&
      !project.publish_targets?.some((t) => t.id === publishTarget)
    ) {
      return refused(
        `--publish-target ${publishTarget} is not a target in chainplot.yaml`,
        "add the target to chainplot.yaml, then plan --intent publish + apply",
      );
    }

    // Authorization: replay only the class the last applied plan authorized.
    const lastKey = lastSucceededRunKey(cwd);
    if (lastKey !== null) {
      const lastProject = readJournalProject(cwd, lastKey);
      if (lastProject !== null) {
        const before = ingestSignature(lastProject);
        const after = ingestSignature(project);
        if (before !== after) {
          return refused(
            "addresses, bounds, chain identity, or publish targets changed since the last applied plan; refresh may not widen scope",
            "run plan --intent ingest + apply out-of-band",
          );
        }
      }
    }
    // No last applied plan: authorization derives from the project file alone
    // (first follow_finalized run from start_block is allowed; nothing else widens).

    const chain = project.chain_sources[0];
    const rpcClient = createRpcClient(process.env[chain.rpc_secret] ?? "");
    const { planPath } = await generatePlan({
      intent: "refresh",
      cwd,
      project,
      rpcClient,
    });
    const outcome = await applyPlan({
      cwd,
      planRef: planPath,
      adapter: rindexerAdapter(),
      rindexerBin: process.env.CHAINPLOT_RINDEXER_BIN ?? "rindexer",
      rpcClient,
      onProgress: jsonl ? progressWriter : undefined,
    });

    if (publishTarget !== undefined) {
      const targetDoc = project.publish_targets?.find(
        (t) => t.id === publishTarget,
      );
      if (!targetDoc) {
        return refused(`publish target ${publishTarget} not found`);
      }
      const published = await publishRelease(cwd, targetDoc);
      return okResult("refresh", { ...outcome, publish: published });
    }
    return okResult("refresh", outcome);
  } catch (err) {
    if (isCommandError(err)) return failResult("refresh", err);
    throw err;
  }
}

function progressWriter(event: {
  run_id: string;
  stage: string;
  message?: string;
  rows?: number;
}): void {
  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      type: "progress",
      run_id: event.run_id,
      stage: event.stage,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.rows !== undefined ? { rows: event.rows } : {}),
      ts: new Date().toISOString(),
    }) + "\n",
  );
}
