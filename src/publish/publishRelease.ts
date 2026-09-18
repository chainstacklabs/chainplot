import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { commandError, errorMessage } from "../plan/errors.js";
import type { PublishTarget as PublishTargetDoc } from "../project/types.js";
import type {
  LatestPointer,
  PublishResult,
  PublishTarget,
} from "./target.js";

export type { PublishResult, LatestPointer };

import { latestPointer } from "./latestPointer.js";
import { DirectoryTarget } from "./directory.js";
import { S3Target, s3EnvFromProcess } from "./s3.js";

export function resolveTarget(
  targetDoc: PublishTargetDoc,
  projectDir: string,
): PublishTarget {
  if (targetDoc.type === "directory") {
    const root = path.resolve(projectDir, targetDoc.path ?? ".");
    return new DirectoryTarget(root, targetDoc.prefix ?? "");
  }
  const env = s3EnvFromProcess();
  if (!env) {
    throw commandError(
      "missing_credentials",
      "S3 target requires CHAINPLOT_S3_ENDPOINT, CHAINPLOT_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
      { resource_id: targetDoc.id },
    );
  }
  return new S3Target(env, undefined, targetDoc.prefix ?? "");
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

export function assertLicense(targetDoc: PublishTargetDoc): void {
  if (!targetDoc.dataset_license) {
    throw commandError(
      "policy_refused",
      `publish target ${targetDoc.id} has no dataset_license; software license (MIT) is not a dataset license`,
      { resource_id: targetDoc.id, pointer: `/publish_targets/${targetDoc.id}/dataset_license` },
    );
  }
}

interface ReferencedDataset {
  datasetId: string;
  /** Release-relative key the manifest points at. */
  path: string;
  checksum: string;
  /** Where the parquet actually is on this machine. */
  localPath: string;
}

/** Datasets a release points at rather than carries. */
function referencedDatasets(releaseDir: string): ReferencedDataset[] {
  const datasetsDir = path.join(releaseDir, "datasets");
  if (!fs.existsSync(datasetsDir)) return [];
  const out: ReferencedDataset[] = [];
  for (const entry of fs.readdirSync(datasetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(datasetsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      mode?: string;
      source_path?: string;
      external?: { path?: string; checksum?: string };
    };
    if (manifest.mode !== "dataset_referenced") continue;
    const rel = manifest.external?.path;
    const checksum = manifest.external?.checksum;
    if (!rel || !checksum || !manifest.source_path) continue;
    out.push({
      datasetId: entry.name,
      path: rel,
      checksum,
      // source_path is relative to the project, and the release lives at
      // <project>/dist/releases/local.
      localPath: path.resolve(releaseDir, "../../..", manifest.source_path),
    });
  }
  return out;
}

export async function publishRelease(
  projectDir: string,
  targetDoc: PublishTargetDoc,
): Promise<PublishResult> {
  assertLicense(targetDoc);
  const releaseDir = path.join(projectDir, "dist", "releases", "local");
  const releaseJsonPath = path.join(releaseDir, "release.json");
  if (!fs.existsSync(releaseJsonPath)) {
    throw commandError("validation", "no built release found; run build first", {
      resource_id: targetDoc.id,
      suggested_next: "build",
    });
  }

  const target = resolveTarget(targetDoc, projectDir);
  const body = fs.readFileSync(releaseJsonPath, "utf8");
  // Key the prefix on the release's content digest, not on the document
  // bytes: the document carries a build timestamp, so hashing it would mint
  // a new prefix on every rebuild of identical data.
  const release = JSON.parse(body) as { content_digest?: string };
  const releaseId = (
    release.content_digest ??
    createHash("sha256").update(body).digest("hex")
  ).slice(0, 16);
  // A prefix namespaces this project inside a shared bucket; without one,
  // two projects in the same bucket overwrite each other's latest.json.
  const base = targetDoc.prefix ? `${targetDoc.prefix}/` : "";
  const prefix = `${base}releases/${releaseId}`;

  const files = walkFiles(releaseDir).filter((f) => f !== "latest.json");
  const checksums: Record<string, string> = {};
  for (const rel of files) {
    checksums[rel] = createHash("sha256")
      .update(fs.readFileSync(path.join(releaseDir, rel)))
      .digest("hex");
  }

  await target.uploadFiles(releaseDir, prefix, files);
  await target.verifyFiles(prefix, files, checksums);

  // A dataset_referenced release keeps its parquet out of the release, so the
  // walk above never saw it. Upload it beside the release at the path the
  // manifest names, and verify it the same way as everything else — otherwise
  // the reference points at nothing and the mode is decorative.
  const referenced = referencedDatasets(releaseDir);
  for (const ref of referenced) {
    if (!fs.existsSync(ref.localPath)) {
      throw commandError(
        "validation",
        `dataset ${ref.datasetId} is referenced by the release but its snapshot is missing at ${ref.localPath}`,
        { resource_id: ref.datasetId, suggested_next: "build" },
      );
    }
    await target.uploadExternal(ref.localPath, `${prefix}/${ref.path}`);
    await target.verifyFiles(prefix, [ref.path], { [ref.path]: ref.checksum });
  }
  const pointer: LatestPointer = latestPointer(prefix, body);
  await target.promoteLatest(pointer);

  const publicBase = targetDoc.public_base_url?.replace(/\/$/, "") ?? null;
  const dashboardUrl = publicBase ? `${publicBase}/${prefix}/index.html` : null;
  // verifyFiles proved the bytes are in the bucket. It says nothing about the
  // URL handed back: a base URL naming a different bucket, a bucket with public
  // access off, or an endpoint that folded the bucket into every key all pass
  // that check and then 404 for every reader. One GET settles it.
  if (dashboardUrl !== null) {
    await assertPublicUrlServes(dashboardUrl, targetDoc.id);
  }

  return {
    target_id: targetDoc.id,
    release_prefix: prefix,
    latest_url: publicBase ? `${publicBase}/${base}latest.json` : null,
    dashboard_url: dashboardUrl,
    files_uploaded: files.length + referenced.length,
    datasets_referenced: referenced.map((r) => r.path),
    promoted: true,
  };
}

const PUBLIC_CHECK_TIMEOUT_MS = 15_000;

async function assertPublicUrlServes(url: string, targetId: string): Promise<void> {
  let outcome: string;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PUBLIC_CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 200) return;
    outcome = `HTTP ${response.status}`;
  } catch (err) {
    outcome = errorMessage(err);
  }
  throw commandError(
    "transient_dependency",
    `uploaded and promoted, but ${url} answered ${outcome} rather than 200. ` +
      `The files are in the bucket; the public URL does not serve them. Check that ` +
      `public_base_url is this bucket's public origin, that the bucket allows ` +
      `public reads, and that CHAINPLOT_S3_ENDPOINT carries no path.`,
    { resource_id: targetId, retryable: true, suggested_next: "publish" },
  );
}
