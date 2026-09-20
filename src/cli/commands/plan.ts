import { failResult, okResult, type CommandResult } from "../envelope.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";
import { createRpcClient } from "../../rpc/client.js";
import { generatePlan } from "../../plan/generate.js";
import { isCommandError } from "./build.js";

export async function planCommand(
  cwd: string,
  intent: string,
  publishTargetId?: string,
): Promise<CommandResult> {
  if (
    intent !== "ingest" &&
    intent !== "refresh" &&
    intent !== "build" &&
    intent !== "publish"
  ) {
    return failResult("plan", {
      code: "validation",
      message: `unknown intent: ${intent}`,
      resource_id: null,
      pointer: "/intent",
      retryable: false,
      suggested_next: "plan --intent ingest|refresh|build|publish",
    });
  }
  try {
    const doc = loadProject(cwd);
    const validated = validateProject(doc, cwd);
    if (!validated.ok) return failResult("plan", validated.error);
    const project = validated.project;
    if (intent !== "build" && intent !== "publish") {
      if (!project.chain_sources?.length || !project.event_sources?.length) {
        return failResult("plan", {
          code: "policy_refused",
          message: "plan --intent ingest|refresh requires an ingest project (chain_sources + event_sources)",
          resource_id: project.id,
          pointer: "/chain_sources",
          retryable: false,
          suggested_next: null,
        });
      }
    }
    const chain = project.chain_sources?.[0];
    const rpcUrl = chain ? (process.env[chain.rpc_secret] ?? "") : "";
    const { plan, planPath } = await generatePlan({
      intent,
      cwd,
      project,
      rpcClient: createRpcClient(rpcUrl),
      publishTargetId,
    });
    return okResult("plan", {
      plan_id: plan.plan_id,
      plan_path: planPath,
      intent: plan.intent,
      chain: plan.chain,
      sources: plan.sources,
      actions: plan.actions,
      limits: plan.limits,
      state_assumptions: plan.state_assumptions,
    });
  } catch (err) {
    if (isCommandError(err)) return failResult("plan", err);
    throw err;
  }
}
