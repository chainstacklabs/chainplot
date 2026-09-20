import fs from "node:fs";
import path from "node:path";

export type RunStatus = "running" | "succeeded" | "failed" | "canceled";

export interface JournalStatus {
  status: RunStatus;
  plan_id: string;
  plan_digest: string;
  updated_at: string;
  result?: unknown;
}

export interface RunSummary {
  idempotency_key: string;
  plan_id: string;
  status: RunStatus;
  updated_at: string;
}

export function journalDir(cwd: string, key: string): string {
  return path.join(cwd, ".chainplot", "runs", key);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function writeJournalPlan(cwd: string, key: string, plan: unknown): void {
  writeJson(path.join(journalDir(cwd, key), "plan.json"), plan);
}

export function readJournalPlan<T>(cwd: string, key: string): T | null {
  return readJson<T>(path.join(journalDir(cwd, key), "plan.json"));
}

export function writeJournalStatus(
  cwd: string,
  key: string,
  status: Omit<JournalStatus, "updated_at"> & { updated_at?: string },
): void {
  writeJson(path.join(journalDir(cwd, key), "status.json"), {
    ...status,
    updated_at: status.updated_at ?? new Date().toISOString(),
  });
}

export function readJournalStatus(
  cwd: string,
  key: string,
): JournalStatus | null {
  return readJson<JournalStatus>(path.join(journalDir(cwd, key), "status.json"));
}

export function writeJournalProject(
  cwd: string,
  key: string,
  project: unknown,
): void {
  writeJson(path.join(journalDir(cwd, key), "project.json"), project);
}

export function readJournalProject<T>(cwd: string, key: string): T | null {
  return readJson<T>(path.join(journalDir(cwd, key), "project.json"));
}

export function lastSucceededRunKey(cwd: string): string | null {
  const succeeded = listRuns(cwd).filter((r) => r.status === "succeeded");
  return succeeded.at(-1)?.idempotency_key ?? null;
}

export function appendCheckpoint(
  cwd: string,
  key: string,
  entry: Record<string, unknown>,
): void {
  const file = path.join(journalDir(cwd, key), "checkpoints.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
  );
}

export function listRuns(cwd: string): RunSummary[] {
  const runsDir = path.join(cwd, ".chainplot", "runs");
  if (!fs.existsSync(runsDir)) return [];
  const out: RunSummary[] = [];
  for (const key of fs.readdirSync(runsDir)) {
    const status = readJournalStatus(cwd, key);
    if (status) {
      out.push({
        idempotency_key: key,
        plan_id: status.plan_id,
        status: status.status,
        updated_at: status.updated_at,
      });
    }
  }
  return out.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}
