import path from "node:path";
import type { CommandError } from "../cli/envelope.js";
import { loadProject } from "../project/load.js";
import { validateProject } from "../project/validate.js";
import { describeParquet } from "../query/runQuery.js";

export interface DatasetDescribeData {
  id: string;
  mode: "dataset_included";
  snapshot: string;
  columns: { name: string; logical_type: string }[];
  coverage: null;
}

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

export async function describeDataset(
  projectDir: string,
  datasetId: string,
): Promise<DatasetDescribeData> {
  const doc = loadProject(projectDir);
  const result = validateProject(doc, projectDir);
  if (!result.ok) {
    throw result.error;
  }

  const dataset = (result.project.datasets ?? []).find((d) => d.id === datasetId);
  if (!dataset) {
    throw error("validation", `unknown dataset: ${datasetId}`, {
      resource_id: datasetId,
      pointer: "/datasets",
    });
  }

  const parquetPath = path.resolve(projectDir, dataset.snapshot);
  const columns = await describeParquet(parquetPath);
  return {
    id: dataset.id,
    mode: "dataset_included",
    snapshot: dataset.snapshot,
    columns,
    coverage: null,
  };
}
