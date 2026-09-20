import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../../src/config/env.js";
import { runCli, type CommandResult } from "../../src/cli/run.js";

// Load the repo-root .env once so env-gated tests see real values.
loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));

export async function runCliJson(
  argv: string[],
  cwd: string,
): Promise<CommandResult> {
  return runCli(argv, { cwd });
}
