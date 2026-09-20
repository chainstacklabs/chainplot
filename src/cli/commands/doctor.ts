import { failResult, okResult, type CommandResult } from "../envelope.js";
import { runDoctor } from "../../publish/doctor.js";
import { isCommandError } from "./build.js";

export async function doctorCommand(cwd: string): Promise<CommandResult> {
  try {
    const report = await runDoctor(cwd);
    const failed = report.checks.some((c) => c.status === "fail");
    return okResult("doctor", { ...report, healthy: !failed });
  } catch (err) {
    if (isCommandError(err)) return failResult("doctor", err);
    throw err;
  }
}
