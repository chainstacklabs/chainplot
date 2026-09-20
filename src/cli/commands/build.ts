import { failResult, okResult, type CommandError, type CommandResult } from "../envelope.js";
import { buildRelease } from "../../publish/writeRelease.js";

export function isCommandError(err: unknown): err is CommandError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "resource_id" in err &&
    "pointer" in err &&
    "retryable" in err &&
    "suggested_next" in err
  );
}

export async function build(
  cwd: string,
  mode?: "dataset_included" | "results_only" | "dataset_referenced",
): Promise<CommandResult> {
  const command = "build";
  try {
    const data = await buildRelease(cwd, { mode });
    return okResult(command, data);
  } catch (err) {
    if (isCommandError(err)) {
      return failResult(command, err);
    }
    throw err;
  }
}
