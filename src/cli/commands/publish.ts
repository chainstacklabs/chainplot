import { failResult, okResult, type CommandResult } from "../envelope.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";
import { generatePlan } from "../../plan/generate.js";
import { applyPlan } from "../../plan/apply.js";
import { rindexerAdapter } from "../../ingest/rindexer/index.js";
import { createRpcClient } from "../../rpc/client.js";
import { isCommandError } from "./build.js";

export async function publishCommand(
  cwd: string,
  targetId?: string,
): Promise<CommandResult> {
  try {
    const doc = loadProject(cwd);
    const validated = validateProject(doc, cwd);
    if (!validated.ok) return failResult("publish", validated.error);
    const project = validated.project;
    const chain = project.chain_sources?.[0];
    const { planPath } = await generatePlan({
      intent: "publish",
      cwd,
      project,
      rpcClient: createRpcClient(
        chain ? (process.env[chain.rpc_secret] ?? "") : "",
      ),
      publishTargetId: targetId,
    });
    const outcome = await applyPlan({
      cwd,
      planRef: planPath,
      adapter: rindexerAdapter(),
      rindexerBin: process.env.CHAINPLOT_RINDEXER_BIN ?? "rindexer",
      rpcClient: createRpcClient(""),
    });
    return okResult("publish", outcome);
  } catch (err) {
    if (isCommandError(err)) return failResult("publish", err);
    throw err;
  }
}
