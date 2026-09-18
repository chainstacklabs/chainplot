import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { commandError } from "../plan/errors.js";
import {
  guardedFetch,
  FORK_LIMITS,
  type FetchGuardOptions,
} from "./fetchGuard.js";

const ajv = new Ajv2020({ strict: true });
const releaseSchema = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../schemas/release.schema.json",
    ),
    "utf8",
  ),
) as object;
const validateRelease = ajv.compile(releaseSchema);

export interface ReleaseDoc {
  schema_version: number;
  project_id: string;
  mode: string;
  queries: string[];
  dashboards: string[];
  generated_at: string;
  snapshots: { dataset_id: string; snapshot_id: string }[];
  coverage: unknown[];
  finality: unknown;
  files: { path: string; checksum: string }[];
}

export interface ForkLimits {
  releaseJsonBytes: number;
  totalBytes: number;
  perRequestTimeoutMs: number;
}

export const DEFAULT_LIMITS: ForkLimits = {
  releaseJsonBytes: FORK_LIMITS.releaseJsonBytes,
  totalBytes: FORK_LIMITS.totalBytes,
  perRequestTimeoutMs: FORK_LIMITS.perRequestTimeoutMs,
};

export interface ForkSource {
  kind: "local" | "url";
  location: string;
}

export function parseForkSource(from: string): ForkSource {
  if (/^https:\/\//.test(from)) return { kind: "url", location: from };
  if (fs.existsSync(from)) return { kind: "local", location: from };
  throw commandError("validation", `fork source not found: ${from}`);
}

function readLocal(releaseRoot: string, rel: string, maxBytes: number): Buffer {
  const resolved = path.resolve(releaseRoot, rel);
  if (resolved !== releaseRoot && !resolved.startsWith(releaseRoot + path.sep)) {
    throw commandError("policy_refused", `fork: path traversal in ${rel}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.size > maxBytes) {
    throw commandError("policy_refused", `fork: ${rel} exceeds byte cap (${maxBytes})`);
  }
  return fs.readFileSync(resolved);
}

/** guardedFetch only carries the status in its message, so match it there. */
export function isReleaseNotFound(err: unknown): boolean {
  return (err as { message?: string })?.message === "fork fetch: HTTP 404";
}

/**
 * A remote `--from` may name a release directory or a publish root — the same
 * two shapes the local branch already accepts. Try the release directly; if it
 * is not there, follow latest.json and verify the checksum it names, so a
 * pointer that has moved on cannot hand back a mismatched release.
 *
 * The publish root is the stable URL: the release prefix changes on every
 * publish, so anything that documents one goes stale immediately.
 */
export async function resolveRemoteRelease(
  base: string,
  fetchOne: (url: string) => Promise<Buffer>,
): Promise<{ body: Buffer; prefix: string | null }> {
  try {
    return { body: await fetchOne(`${base}/release.json`), prefix: null };
  } catch (err) {
    if (!isReleaseNotFound(err)) throw err;
  }
  const pointer = JSON.parse((await fetchOne(`${base}/latest.json`)).toString("utf8")) as {
    release_prefix: string;
    release_json_checksum: string;
  };
  const releaseBase = pointerReleaseUrl(base, pointer.release_prefix);
  const body = await fetchOne(`${releaseBase}/release.json`);
  if (createHash("sha256").update(body).digest("hex") !== pointer.release_json_checksum) {
    throw commandError(
      "policy_refused",
      "fork: release.json does not match the latest.json pointer checksum",
    );
  }
  return { body, prefix: relativePrefix(base, pointer.release_prefix) };
}

/**
 * `release_prefix` in latest.json is written relative to the bucket, while
 * `--from` is whatever URL the reader was given — usually the publish root,
 * which already ends with the target's own prefix. Appending one to the other
 * would repeat that prefix, so drop the segments they share.
 */
function relativePrefix(base: string, releasePrefix: string): string {
  const basePath = new URL(base).pathname.split("/").filter(Boolean);
  const parts = releasePrefix.split("/").filter(Boolean);
  for (let n = Math.min(basePath.length, parts.length); n > 0; n--) {
    if (basePath.slice(-n).join("/") === parts.slice(0, n).join("/")) {
      return parts.slice(n).join("/");
    }
  }
  return parts.join("/");
}

function pointerReleaseUrl(base: string, releasePrefix: string): string {
  const rest = relativePrefix(base, releasePrefix);
  return rest ? `${base}/${rest}` : base;
}

export async function importRelease(
  from: string,
  outputDir: string,
  opts: { allowPrivateNetworks?: boolean } = {},
): Promise<{
  project_dir: string;
  files: number;
  release_prefix: string | null;
  mode: string;
  datasets_referenced: string[];
  warnings: string[];
}> {
  const source = parseForkSource(from);
  const guard: FetchGuardOptions = {
    allowPrivateNetworks: opts.allowPrivateNetworks,
    maxBytes: DEFAULT_LIMITS.releaseJsonBytes,
  };

  // 1. release.json (≤ 1 MiB), validate against the frozen schema.
  let releaseBody: Buffer;
  let releaseRoot: string | null = null;
  let releasePrefix: string | null = null;
  if (source.kind === "local") {
    // Accept either a release dir (contains release.json) or a publish root (contains latest.json).
    if (fs.existsSync(path.join(source.location, "release.json"))) {
      releaseRoot = path.resolve(source.location);
      releaseBody = readLocal(releaseRoot, "release.json", DEFAULT_LIMITS.releaseJsonBytes);
    } else if (fs.existsSync(path.join(source.location, "latest.json"))) {
      const pointer = JSON.parse(
        fs.readFileSync(path.join(source.location, "latest.json"), "utf8"),
      ) as { release_prefix: string; release_json_checksum: string };
      releaseRoot = path.resolve(source.location);
      releasePrefix = pointer.release_prefix;
      releaseBody = readLocal(
        releaseRoot,
        path.join(pointer.release_prefix, "release.json"),
        DEFAULT_LIMITS.releaseJsonBytes,
      );
      const actual = createHash("sha256").update(releaseBody).digest("hex");
      if (actual !== pointer.release_json_checksum) {
        throw commandError(
          "policy_refused",
          "fork: release.json does not match the latest.json pointer checksum",
        );
      }
    } else {
      throw commandError("validation", `no release.json or latest.json in ${source.location}`);
    }
  } else {
    const base = source.location.replace(/\/$/, "");
    const resolved = await resolveRemoteRelease(
      base,
      async (url) => (await guardedFetch(url, guard)).body,
    );
    releaseBody = resolved.body;
    releasePrefix = resolved.prefix;
  }
  if (!validateRelease(JSON.parse(releaseBody.toString("utf8")))) {
    throw commandError("validation", "fork: release.json failed schema validation");
  }
  const release = JSON.parse(releaseBody.toString("utf8")) as ReleaseDoc;

  // 2. Download/copy declared files with checksums, hard total cap.
  const outDir = path.resolve(outputDir);
  fs.mkdirSync(outDir, { recursive: true });
  let total = releaseBody.length;
  for (const file of release.files) {
    if (file.path.includes("..") || path.isAbsolute(file.path)) {
      throw commandError("policy_refused", `fork: unsafe file path ${file.path}`);
    }
    let body: Buffer;
    if (source.kind === "local") {
      body = readLocal(
        releaseRoot!,
        releasePrefix ? path.join(releasePrefix, file.path) : file.path,
        DEFAULT_LIMITS.totalBytes,
      );
    } else {
      const base = source.location.replace(/\/$/, "");
      const res = await guardedFetch(`${base}/${remotePath(releasePrefix, file.path)}`, {
        ...guard,
        maxBytes: DEFAULT_LIMITS.totalBytes,
      });
      body = res.body;
    }
    total += body.length;
    if (total > DEFAULT_LIMITS.totalBytes) {
      throw commandError(
        "policy_refused",
        `fork: total download exceeds ${DEFAULT_LIMITS.totalBytes} bytes`,
      );
    }
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== file.checksum) {
      throw commandError(
        "policy_refused",
        `fork: checksum mismatch for ${file.path}`,
      );
    }
    const dest = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }

  // 2b. A dataset_referenced release points at its parquet instead of
  //     carrying it, so the loop above never fetched it. Pull it in and verify
  //     it against the manifest, or the fork is a recipe with nothing to run
  //     against.
  const referenced: string[] = [];
  for (const dataset of manifestDatasets(outDir)) {
    const body = await readReferenced(source, releasePrefix, dataset, guard);
    total += body.length;
    if (total > DEFAULT_LIMITS.totalBytes) {
      throw commandError(
        "policy_refused",
        `fork: total download exceeds ${DEFAULT_LIMITS.totalBytes} bytes`,
      );
    }
    const actual = createHash("sha256").update(body).digest("hex");
    if (actual !== dataset.checksum) {
      throw commandError(
        "policy_refused",
        `fork: checksum mismatch for referenced dataset ${dataset.path}`,
      );
    }
    const dest = path.join(outDir, dataset.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    referenced.push(dataset.path);
  }

  // 3. Forked project: chainplot.yaml from the sanitized source bundle,
  //    with dataset snapshots pinned to the forked copies.
  const sourceYamlEntry = release.files.find((f) => f.path === "source/chainplot.yaml");
  if (!sourceYamlEntry) {
    throw commandError(
      "policy_refused",
      "fork: release has no source/chainplot.yaml; results-only fork needs a recipe",
    );
  }
  const { parse: parseYaml, stringify: stringifyYaml } = await import("yaml");
  const projectDoc = parseYaml(
    fs.readFileSync(path.join(outDir, "source/chainplot.yaml"), "utf8"),
  ) as {
    datasets?: { id: string; snapshot: string }[];
    chain_sources?: unknown;
    event_sources?: unknown;
    publish_targets?: unknown;
  };
  const warnings: string[] = [];
  for (const dataset of projectDoc.datasets ?? []) {
    const basename = path.basename(dataset.snapshot);
    dataset.snapshot = `datasets/${dataset.id}/tables/${basename}`;
  }
  // Referenced datasets land at the very same layout, so nothing special is
  // needed here — the assertion is that they did land.
  for (const rel of referenced) {
    if (!fs.existsSync(path.join(outDir, rel))) {
      throw commandError("internal", `fork: referenced dataset ${rel} was not written`);
    }
  }
  // A fork has no chain access (spec §16.4): strip ingest sources so the
  // forked project is dataset-only. Expanding history is a new ingest project.
  delete projectDoc.chain_sources;
  delete projectDoc.event_sources;
  // The publish targets name the original author's bucket. No credentials
  // come across, so nothing can be written there — but a fork that kept them
  // would aim its first `publish` at a stranger's storage.
  if (projectDoc.publish_targets !== undefined) {
    delete projectDoc.publish_targets;
    warnings.push(
      "publish_targets dropped: they pointed at the original author's storage. " +
        "Add your own publish_targets before running publish.",
    );
  }
  fs.writeFileSync(path.join(outDir, "chainplot.yaml"), stringifyYaml(projectDoc));

  // Recipe directories live at project root for the forked copy.
  for (const dir of ["queries", "models", "tests", "abis", "schemas"]) {
    const src = path.join(outDir, "source", dir);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(outDir, dir), { recursive: true });
    }
  }

  // A results-only release publishes the recipe and the rendered answers but
  // no dataset, so the fork is real and useful yet cannot rebuild until it is
  // pointed at a snapshot. Saying so here beats a bare "missing snapshot file"
  // from a `build` the forker has no reason to expect to fail.
  if (release.mode === "results_only") {
    warnings.push(
      `release mode is ${release.mode}: the dataset is not part of it, so the ` +
        `forked project has the recipe and the published results but no snapshot. ` +
        `Point ${datasetPaths(projectDoc)} at your own copy before running build.`,
    );
  }

  return {
    project_dir: outDir,
    files: release.files.length + referenced.length,
    release_prefix: releasePrefix,
    mode: release.mode,
    datasets_referenced: referenced,
    warnings,
  };
}

interface ReferencedDataset {
  /** Release-relative path the manifest names. */
  path: string;
  checksum: string;
}

/** Datasets the forked release points at rather than carries. */
function manifestDatasets(outDir: string): ReferencedDataset[] {
  const datasetsDir = path.join(outDir, "datasets");
  if (!fs.existsSync(datasetsDir)) return [];
  const out: ReferencedDataset[] = [];
  for (const entry of fs.readdirSync(datasetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(datasetsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      mode?: string;
      external?: { path?: string; checksum?: string };
    };
    if (manifest.mode !== "dataset_referenced") continue;
    const rel = manifest.external?.path;
    const checksum = manifest.external?.checksum;
    if (!rel || !checksum) continue;
    if (rel.includes("..") || path.isAbsolute(rel)) {
      throw commandError("policy_refused", `fork: unsafe dataset path ${rel}`);
    }
    out.push({ path: rel, checksum });
  }
  return out;
}

/** Fetch or copy a referenced dataset from wherever the release came from. */
async function readReferenced(
  source: ForkSource,
  releasePrefix: string | null,
  dataset: ReferencedDataset,
  guard: FetchGuardOptions,
): Promise<Buffer> {
  if (source.kind === "local") {
    return readLocal(
      path.resolve(source.location),
      releasePrefix ? path.join(releasePrefix, dataset.path) : dataset.path,
      DEFAULT_LIMITS.totalBytes,
    );
  }
  const base = source.location.replace(/\/$/, "");
  const res = await guardedFetch(`${base}/${remotePath(releasePrefix, dataset.path)}`, {
    ...guard,
    maxBytes: DEFAULT_LIMITS.totalBytes,
  });
  return res.body;
}

/** Release-relative path, under the pointer's prefix when we followed one. */
function remotePath(releasePrefix: string | null, filePath: string): string {
  return releasePrefix ? `${releasePrefix}/${filePath}` : filePath;
}

function datasetPaths(doc: { datasets?: { id: string }[] }): string {
  const ids = (doc.datasets ?? []).map((d) => d.id);
  return ids.length ? `datasets (${ids.join(", ")})` : "the datasets";
}
