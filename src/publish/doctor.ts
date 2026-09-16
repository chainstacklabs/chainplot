import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commandError, errorMessage } from "../plan/errors.js";
import { loadProject } from "../project/load.js";
import { validateProject } from "../project/validate.js";
import type { ProjectDocument } from "../project/types.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "fail" | "unverified" | "skipped";
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Project file
  let project: ProjectDocument | null = null;
  let projectError: string | null = null;
  try {
    const doc = loadProject(cwd);
    const validated = validateProject(doc, cwd);
    if (validated.ok) {
      project = validated.project;
      checks.push({ name: "project", status: "ok", detail: "chainplot.yaml valid" });
    } else {
      projectError = validated.error.message;
      checks.push({ name: "project", status: "fail", detail: projectError });
    }
  } catch (err) {
    throw commandError(
      "validation",
      errorMessage(err),
    );
  }

  // Secrets: presence only, never values.
  const chain = project?.chain_sources?.[0];
  const rpcEnvName = chain?.rpc_secret ?? "RPC_URL";
  checks.push({
    name: "secrets",
    status: process.env[rpcEnvName] ? "ok" : "skipped",
    detail: `${rpcEnvName} ${process.env[rpcEnvName] ? "present" : "not set (needed for ingest)"}; value not shown`,
  });
  checks.push({
    name: "database",
    status: process.env.DATABASE_URL ? "ok" : "skipped",
    detail: `DATABASE_URL ${process.env.DATABASE_URL ? "present" : "not set (needed for ingest)"}; value not shown`,
  });

  // RPC: finalized-head probe when the secret is present.
  if (chain && process.env[chain.rpc_secret]) {
    try {
      const { createRpcClient } = await import("../rpc/client.js");
      const { getFinalizedHead } = await import("../rpc/heads.js");
      const head = await getFinalizedHead(
        createRpcClient(process.env[chain.rpc_secret]!),
      );
      checks.push({
        name: "rpc",
        status: "ok",
        detail: `finalized head ${head.number}`,
      });
    } catch (err) {
      checks.push({
        name: "rpc",
        status: "fail",
        detail: errorMessage(err),
      });
    }
  } else {
    checks.push({ name: "rpc", status: "skipped", detail: "RPC secret not set" });
  }

  // rindexer binary (needed for ingest only).
  const rindexerBin = process.env.CHAINPLOT_RINDEXER_BIN ?? "rindexer";
  const rindexerName = rindexerBin.split(" ")[0] ?? rindexerBin;
  let rindexerVersion: string | null = null;
  try {
    rindexerVersion = execFileSync(rindexerName, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    rindexerVersion = null;
  }
  checks.push({
    name: "rindexer",
    status: rindexerVersion ? "ok" : "skipped",
    detail: rindexerVersion ?? `${rindexerName} not found (needed for ingest)`,
  });

  // Writable storage.
  try {
    const probe = path.join(cwd, ".chainplot", "doctor.tmp");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    checks.push({ name: "storage", status: "ok", detail: `${cwd}/.chainplot writable` });
  } catch (err) {
    checks.push({
      name: "storage",
      status: "fail",
      detail: errorMessage(err),
    });
  }

  // S3: HeadBucket-level presence only; write/promote stays unverified.
  if (process.env.CHAINPLOT_S3_ENDPOINT && process.env.AWS_ACCESS_KEY_ID) {
    checks.push({
      name: "s3",
      status: "unverified",
      detail:
        "S3 env configured; write/promote capability is proven only at upload time",
    });
  } else {
    checks.push({ name: "s3", status: "skipped", detail: "no S3 env configured" });
  }

  return { checks };
}
