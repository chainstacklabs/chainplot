import { failResult, okResult, type CommandError, type CommandResult } from "../envelope.js";
import { describeDataset } from "../../snapshot/describe.js";

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

export async function datasetDescribe(
  cwd: string,
  datasetId: string,
): Promise<CommandResult> {
  const command = "dataset describe";
  try {
    const data = await describeDataset(cwd, datasetId);
    return okResult(command, data);
  } catch (err) {
    if (isCommandError(err)) {
      return failResult(command, err);
    }
    throw err;
  }
}
