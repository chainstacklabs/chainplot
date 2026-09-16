#!/usr/bin/env node
import { failResult, type CommandResult } from "./envelope.js";
import { runCli } from "./run.js";
import { loadDotEnv } from "../config/env.js";
import { errorMessage } from "../plan/errors.js";

// Secrets enter through the environment or a local .env (see .env.example).
loadDotEnv(process.cwd());

let result: CommandResult;
try {
  result = await runCli(process.argv.slice(2), { cwd: process.cwd() });
} catch (err) {
  const argv = process.argv.slice(2).filter((a) => a !== "--json");
  const command = argv.find((a) => !a.startsWith("-")) ?? "";
  result = failResult(command, {
    code: "internal",
    message: errorMessage(err),
    resource_id: null,
    pointer: null,
    retryable: false,
    suggested_next: null,
  });
}
process.stdout.write(JSON.stringify(result) + "\n");
// `serve` is long-running: its result (with the URL) is printed once and the
// process stays alive until SIGINT/SIGTERM (handled inside the command).
if (result.ok && result.command === "serve") {
  // keep the event loop alive; no exit code until the signal handler runs.
} else {
  process.exit(result.ok ? 0 : 1);
}
