import fs from "node:fs";
import path from "node:path";
import type { CoverageFile, CoverageSegment } from "./coverage.js";

const COVERAGE_PATH = ["chainplot", "coverage.json"];

export function coverageFilePath(cwd: string): string {
  return path.join(cwd, ".chainplot", "coverage.json");
}

export function readCoverageFile(cwd: string): CoverageFile {
  const file = coverageFilePath(cwd);
  if (!fs.existsSync(file)) {
    return { schema_version: 1, chain_id: 0, sources: [] };
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as CoverageFile;
}

export function writeCoverageFile(cwd: string, file: CoverageFile): void {
  const file_ = coverageFilePath(cwd);
  fs.mkdirSync(path.dirname(file_), { recursive: true });
  fs.writeFileSync(file_, `${JSON.stringify(file, null, 2)}\n`);
}

export function segmentsFor(
  file: CoverageFile,
  sourceId: string,
): CoverageSegment[] {
  return file.sources.find((s) => s.source_id === sourceId)?.segments ?? [];
}

export function appendSegment(
  file: CoverageFile,
  sourceId: string,
  segment: CoverageSegment,
): CoverageFile {
  const existing = file.sources.find((s) => s.source_id === sourceId);
  if (existing) {
    existing.segments.push(segment);
  } else {
    file.sources.push({ source_id: sourceId, segments: [segment] });
  }
  return file;
}
