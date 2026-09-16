import { okResult, failResult, type CommandResult } from "../envelope.js";
import { applyPlan } from "../../plan/apply.js";
import { rindexerAdapter } from "../../ingest/rindexer/index.js";
import { createRpcClient } from "../../rpc/client.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";
import { isCommandError } from "./build.js";

export async function applyCommand(
  cwd: string,
  planRef: string,
  idempotencyKey?: string,
  jsonl = false,
): Promise<CommandResult> {
  try {
    const outcome = await applyPlan({
      cwd,
      planRef,
      idempotencyKey,
      adapter: rindexerAdapter(),
      rindexerBin: process.env.CHAINPLOT_RINDEXER_BIN ?? "rindexer",
      rpcClient: createRpcClient(rpcUrlFor(cwd)),
      onProgress: jsonl ? writeProgressLine : undefined,
    });
    return okResult("apply", outcome);
  } catch (err) {
    if (isCommandError(err)) return failResult("apply", err);
    throw err;
  }
}

function writeProgressLine(event: {
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

function rpcUrlFor(cwd: string): string {
  const doc = loadProject(cwd);
  const validated = validateProject(doc, cwd);
  if (!validated.ok) return "";
  const secret = validated.project.chain_sources?.[0]?.rpc_secret;
  return (secret && process.env[secret]) || "";
}
