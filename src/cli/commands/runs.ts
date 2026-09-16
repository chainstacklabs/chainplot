import fs from "node:fs";
import path from "node:path";
import { okResult, failResult, type CommandResult } from "../envelope.js";
import {
  listRuns,
  readJournalPlan,
  readJournalStatus,
  writeJournalStatus,
  journalDir,
} from "../../runtime/journal.js";

export function runsList(cwd: string): CommandResult {
  return okResult("runs list", { runs: listRuns(cwd) });
}

export function runsShow(cwd: string, key: string): CommandResult {
  const status = readJournalStatus(cwd, key);
  if (!status) {
    return failResult("runs show", {
      code: "validation",
      message: `no run with idempotency key ${key}`,
      resource_id: key,
      pointer: "/idempotency_key",
      retryable: false,
      suggested_next: "runs list",
    });
  }
  return okResult("runs show", {
    idempotency_key: key,
    status,
    plan: readJournalPlan(cwd, key),
  });
}

export function runsCancel(cwd: string, key: string): CommandResult {
  const status = readJournalStatus(cwd, key);
  if (!status) {
    return failResult("runs cancel", {
      code: "validation",
      message: `no run with idempotency key ${key}`,
      resource_id: key,
      pointer: "/idempotency_key",
      retryable: false,
      suggested_next: "runs list",
    });
  }
  if (status.status === "succeeded") {
    return failResult("runs cancel", {
      code: "validation",
      message: `run ${key} already succeeded; nothing to cancel`,
      resource_id: key,
      pointer: null,
      retryable: false,
      suggested_next: null,
    });
  }
  // Two halves, because there are two situations.
  //
  // A live apply notices the flag at its next checkpoint and stops there —
  // cancellation is cooperative, not a kill. But a run whose process died
  // leaves the journal saying "running", and `apply` refuses to start while it
  // does, so the flag alone would strand the project with no way back. Moving
  // the run to a terminal state here is what unsticks it.
  fs.mkdirSync(journalDir(cwd, key), { recursive: true });
  fs.writeFileSync(
    path.join(journalDir(cwd, key), "cancel_requested"),
    new Date().toISOString(),
  );
  writeJournalStatus(cwd, key, {
    status: "canceled",
    plan_id: status.plan_id,
    plan_digest: status.plan_digest,
  });
  return okResult("runs cancel", {
    idempotency_key: key,
    cancel_requested: true,
    status: "canceled",
    was: status.status,
  });
}
