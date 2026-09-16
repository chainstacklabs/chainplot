import { failResult, okResult, type CommandResult } from "../envelope.js";
import { importRelease } from "../../fork/importRelease.js";
import { isCommandError } from "./build.js";

export async function forkCommand(
  from: string,
  output: string,
  allowPrivateNetworks = false,
): Promise<CommandResult> {
  try {
    const { warnings, ...result } = await importRelease(from, output, {
      allowPrivateNetworks,
    });
    return { ...okResult("fork", result), warnings };
  } catch (err) {
    if (isCommandError(err)) return failResult("fork", err);
    throw err;
  }
}
