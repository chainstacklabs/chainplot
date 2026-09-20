import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { CommandError } from "../cli/envelope.js";
import { loadProject } from "../project/load.js";
import { validateProject } from "../project/validate.js";
import { topoSortModels } from "../project/modelGraph.js";
import { runQuery } from "../query/runQuery.js";
import { isComplete, requiredEnd } from "../ingest/coverage.js";
import { readCoverageFile, segmentsFor } from "../ingest/coverageStore.js";
import { lastProvenCompleteBlock } from "../ingest/coverage.js";
import { copySourceBundle } from "./sourceBundle.js";
import { decorateColumns, rawAmountNames } from "../project/columns.js";
import type { CoverageSegment } from "../ingest/coverage.js";
import { rowLimitFor } from "../project/limits.js";


/**
 * How current the data is, and on whose authority.
 *
 * An ingest project can answer from the chain: the timestamp of the last
 * block proven complete. A dataset-only project cannot, and says so rather
 * than passing a file's mtime off as freshness — a checkout or a `cp`
 * rewrites mtime without the data changing at all.
 */
interface Freshness {
  kind: "chain" | "snapshot_mtime";
  data_through: { block: number; timestamp: string | null } | null;
  indexed_at: string | null;
  snapshot_mtime: string;
}

function isoFromUnixSeconds(seconds: number | undefined): string | null {
  return typeof seconds === "number" && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function freshnessFor(
  segments: CoverageSegment[],
  provenBlock: number,
  snapshotMtime: string,
  isIngest: boolean,
): Freshness {
  if (!isIngest) {
    return {
      kind: "snapshot_mtime",
      data_through: null,
      indexed_at: null,
      snapshot_mtime: snapshotMtime,
    };
  }
  const proven = segments.filter((s) => s.end_block <= provenBlock);
  const last = proven.at(-1);
  const indexedAt = proven
    .map((s) => s.indexed_at)
    .filter((at): at is string => typeof at === "string")
    .sort()
    .at(-1);
  return {
    kind: "chain",
    data_through: {
      block: provenBlock,
      timestamp: isoFromUnixSeconds(last?.end_block_timestamp),
    },
    indexed_at: indexedAt ?? null,
    snapshot_mtime: snapshotMtime,
  };
}

const VIEWER_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../viewer/dist",
);

function error(
  code: CommandError["code"],
  message: string,
  opts: { resource_id?: string | null; pointer?: string | null } = {},
): CommandError {
  return {
    code,
    message,
    resource_id: opts.resource_id ?? null,
    pointer: opts.pointer ?? null,
    retryable: false,
    suggested_next: null,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function buildRelease(
  projectDir: string,
  opts: { mode?: "dataset_included" | "results_only" | "dataset_referenced" } = {},
): Promise<{
  distDir: string;
  files: string[];
}> {
  const doc = loadProject(projectDir);
  const validated = validateProject(doc, projectDir);
  if (!validated.ok) {
    throw validated.error;
  }
  const project = validated.project;

  // Promotion gate: an ingest project's sources must be complete over
  // [start_block, required_end] before any release is written (spec §11).
  if ((project.event_sources ?? []).length > 0) {
    const coverage = readCoverageFile(projectDir);
    for (const source of project.event_sources ?? []) {
      const verdict = isComplete(
        segmentsFor(coverage, source.id),
        source.start_block,
        source.end,
      );
      if (!verdict.complete) {
        throw error(
          "policy_refused",
          `source ${source.id} is incomplete (${verdict.reason ?? "unknown"}); incomplete data cannot be promoted`,
          { resource_id: source.id },
        );
      }
    }
  }

  const datasets = project.datasets ?? [];
  const queries = project.queries ?? [];
  const models = project.models ?? [];
  const datasetById = new Map(datasets.map((d) => [d.id, d]));
  const allTables = Object.fromEntries(
    datasets.map((d) => [d.id, path.resolve(projectDir, d.snapshot)]),
  );

  // Size cap before any query work (fail fast, spec §14.1/§16).
  const MAX_COPIED_BYTES = 100 * 1024 * 1024;
  // An explicit --mode wins, then the project's own declaration, then the
  // conservative default: the page and its answers, without the dataset.
  //
  // Publishing is outward and irreversible, so the default uploads the least
  // that still works. Shipping the parquet is a deliberate choice — it is what
  // lets someone fork the release and recompute, and it is also what turns an
  // 800 KB page into hundreds of megabytes.
  const mode = opts.mode ?? project.policy?.release_mode ?? "results_only";
  let copiedBytes = 0;
  for (const dataset of datasets) {
    const parquetPath = path.resolve(projectDir, dataset.snapshot);
    copiedBytes += fs.statSync(parquetPath).size;
  }
  if (mode === "dataset_included" && copiedBytes > MAX_COPIED_BYTES) {
    throw error(
      "policy_refused",
      `copied dataset size ${copiedBytes} bytes exceeds the ${MAX_COPIED_BYTES}-byte cap; choose --mode results_only, --mode dataset_referenced, or reduce the data`,
      { pointer: "/datasets" },
    );
  }

  // Models materialize in dependency order for every query.
  const modelOrder = topoSortModels(models);
  const modelSql: { id: string; sql: string }[] = modelOrder.map((id) => {
    const model = models.find((m) => m.id === id)!;
    const file = path.resolve(projectDir, model.file);
    if (!fs.existsSync(file)) {
      throw error("validation", `missing model file: ${model.file}`, {
        resource_id: model.id,
        pointer: "/models",
      });
    }
    return { id, sql: fs.readFileSync(file, "utf8") };
  });

  const releasesDir = path.join(projectDir, "dist", "releases");
  fs.mkdirSync(releasesDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(releasesDir, ".tmp-"));
  const files: string[] = [];

  try {
    // Queries (with models materialized first).
    for (const query of queries) {
      const dataset = datasetById.get(query.dataset);
      if (!dataset) {
        throw error("validation", `unknown dataset: ${query.dataset}`, {
          resource_id: query.id,
          pointer: "/queries",
        });
      }
      const sqlPath = path.resolve(projectDir, query.file);
      const data = await runQuery({
        sql: fs.readFileSync(sqlPath, "utf8"),
        // Every dataset is in scope, not just the declared one. Models are
        // materialized into each query's session, so loading one table meant a
        // model over dataset A failed every query on dataset B — which made
        // models unusable in any multi-dataset project. It also lets a query
        // join across datasets. `query.dataset` still names the provenance.
        tables: allTables,
        rawAmountColumns: rawAmountNames(query.raw_amount_columns),
        rowLimit: rowLimitFor(project),
        models: modelSql,
      });

      const rel = path.join("results", `${query.id}.json`);
      writeJson(path.join(staging, rel), {
        schema_version: 1,
        query_id: query.id,
        title: query.title ?? query.id,
        // Display metadata rides on the column descriptors, so the viewer
        // never has to correlate two lists to format a cell.
        columns: decorateColumns(data.columns, query.raw_amount_columns),
        rows: data.rows,
        snapshot: dataset.snapshot,
        query_digest: sha256(fs.readFileSync(sqlPath, "utf8")),
        raw_amount_columns: rawAmountNames(query.raw_amount_columns),
      });
      files.push(rel);
    }

    // Datasets: manifest + parquet copy (mode-dependent).

    const coverageFile = readCoverageFile(projectDir);
    const coverageRows = (project.event_sources ?? []).map((source) => {
      const segments = segmentsFor(coverageFile, source.id);
      const proven = lastProvenCompleteBlock(segments, source.start_block);
      const target = requiredEnd(source.end, segments);
      return {
        source_id: source.id,
        start_block: source.start_block,
        end_block: proven,
        status:
          target !== null && proven >= target ? "complete" : "incomplete",
      };
    });
    const finality = project.chain_sources?.[0]?.finality ?? null;
    const isIngest = (project.event_sources ?? []).length > 0;
    const allSegments = (project.event_sources ?? []).flatMap((source) =>
      segmentsFor(coverageFile, source.id),
    );
    const provenBlock = Math.max(
      0,
      ...coverageRows.map((row) => row.end_block),
    );

    for (const dataset of datasets) {
      const parquetPath = path.resolve(projectDir, dataset.snapshot);
      const manifestRel = path.join("datasets", dataset.id, "manifest.json");
      const freshness = freshnessFor(
        allSegments,
        provenBlock,
        fs.statSync(parquetPath).mtime.toISOString(),
        isIngest,
      );
      const manifest: Record<string, unknown> = {
        schema_version: 1,
        snapshot_id: dataset.id,
        mode,
        files: [] as string[],
        source_path: dataset.snapshot,
        coverage: coverageRows,
        finality,
        freshness,
      };
      if (mode === "dataset_included") {
        const tableRel = path.join(
          "datasets",
          dataset.id,
          "tables",
          path.basename(dataset.snapshot),
        );
        fs.mkdirSync(path.dirname(path.join(staging, tableRel)), {
          recursive: true,
        });
        fs.copyFileSync(parquetPath, path.join(staging, tableRel));
        manifest.files = [`tables/${path.basename(dataset.snapshot)}`];
        files.push(manifestRel, tableRel);
      } else if (mode === "dataset_referenced") {
        // The reference is relative to the release, not to the machine that
        // built it: a consumer resolves it against whatever base URL the
        // release is served from, exactly as the page resolves release.json.
        // Recording the producer's own path made the reference unusable by
        // anyone else. The parquet stays out of `files`, so it is neither
        // copied into the release nor covered by its checksums — `publish`
        // uploads it alongside, and `fork` fetches it on demand.
        manifest.external = {
          path: path.join(
            "datasets",
            dataset.id,
            "tables",
            path.basename(dataset.snapshot),
          ),
          checksum: sha256(fs.readFileSync(parquetPath)),
          bytes: fs.statSync(parquetPath).size,
        };
        files.push(manifestRel);
      } else {
        files.push(manifestRel);
      }
      writeJson(path.join(staging, manifestRel), manifest);
    }

    // Dashboards data. Panel headings are resolved here — panel title, then
    // the query's title, then its id — so the viewer needs no query registry.
    const queryTitles = new Map(queries.map((q) => [q.id, q.title ?? q.id]));
    const dashboardIds: string[] = [];
    for (const dashboard of project.dashboards ?? []) {
      const rel = path.join("dashboards", `${dashboard.id}.json`);
      writeJson(path.join(staging, rel), {
        schema_version: 1,
        dashboard_id: dashboard.id,
        title: dashboard.title,
        description: dashboard.description ?? null,
        panels: dashboard.panels.map((panel) => ({
          ...panel,
          title: panel.title ?? queryTitles.get(panel.query) ?? panel.query,
          span: panel.span ?? "half",
        })),
      });
      files.push(rel);
      dashboardIds.push(dashboard.id);
    }

    // Viewer static assets (release-independent bundle). A release without
    // the viewer is a directory of JSON nobody can read, so its absence is an
    // error rather than a silent omission.
    if (!fs.existsSync(path.join(VIEWER_DIST, "index.html"))) {
      throw error(
        "internal",
        `viewer bundle missing at ${VIEWER_DIST}; run \`pnpm build\` to build it`,
      );
    }
    fs.cpSync(VIEWER_DIST, staging, { recursive: true });
    files.push("index.html");
    for (const asset of walkFiles(path.join(staging, "assets"))) {
      files.push(path.relative(staging, asset));
    }

    // Sanitized source bundle.
    files.push(...copySourceBundle(projectDir, staging));

    // Release document (provenance + per-file checksums for fork).
    const releaseRel = "release.json";
    files.push("release.json");
    // Checksums cover every file written before release.json itself.
    const fileChecksums = files
      .filter((f) => f !== "release.json")
      .map((rel) => ({
        path: rel,
        checksum: createHash("sha256")
          .update(fs.readFileSync(path.join(staging, rel)))
          .digest("hex"),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Identity of a release is its content, not the clock. Rebuilding the
    // same inputs yields the same digest, so re-publishing is idempotent
    // instead of littering the bucket with a new prefix every time.
    const contentDigest = sha256(
      [
        `project:${project.id}`,
        `mode:${mode}`,
        ...fileChecksums.map((f) => `${f.path}:${f.checksum}`),
      ].join("\n"),
    );

    writeJson(path.join(staging, releaseRel), {
      schema_version: 1,
      project_id: project.id,
      mode,
      content_digest: contentDigest,
      queries: queries.map((q) => q.id),
      dashboards: dashboardIds,
      generated_at: new Date().toISOString(),
      snapshots: datasets.map((d) => ({
        dataset_id: d.id,
        snapshot_id: d.id,
      })),
      coverage: coverageRows,
      finality,
      freshness: freshnessFor(
        allSegments,
        provenBlock,
        datasets[0]
          ? fs.statSync(path.resolve(projectDir, datasets[0].snapshot)).mtime.toISOString()
          : new Date().toISOString(),
        isIngest,
      ),
      files: fileChecksums,
    });

    // One build directory, replaced atomically. `serve` and `publish` both
    // read `releases/local`; published history lives in the bucket, keyed by
    // content digest.
    const localDir = path.join(releasesDir, "local");
    if (fs.existsSync(localDir)) {
      fs.rmSync(localDir, { recursive: true, force: true });
    }
    fs.renameSync(staging, localDir);
    return { distDir: localDir, files };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}
