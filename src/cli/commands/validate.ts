import { failResult, okResult, type CommandError, type CommandResult } from "../envelope.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";

function isCommandError(err: unknown): err is CommandError {
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

export function validate(cwd: string): CommandResult {
  const command = "validate";
  try {
    const doc = loadProject(cwd);
    const result = validateProject(doc, cwd);
    if (!result.ok) {
      return failResult(command, result.error);
    }
    return okResult(command, { id: result.project.id });
  } catch (err) {
    if (isCommandError(err)) {
      return failResult(command, err);
    }
    throw err;
  }
}
