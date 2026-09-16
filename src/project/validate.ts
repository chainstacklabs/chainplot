import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { CommandError } from "../cli/envelope.js";
import { topoSortModels } from "./modelGraph.js";
import type { ProjectDocument } from "./types.js";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../schemas/project.schema.json",
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as object;
const validateSchema = ajv.compile(schema);

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

function pointerFromAjv(err: ErrorObject): string | null {
  if (err.keyword === "additionalProperties") {
    const prop = (err.params as { additionalProperty?: string }).additionalProperty;
    if (typeof prop === "string") {
      return `${err.instancePath}/${prop}`;
    }
  }
  return err.instancePath || null;
}

export function validateProject(
  doc: unknown,
  projectDir: string,
):
  | { ok: true; project: ProjectDocument }
  | { ok: false; error: CommandError } {
  if (
    doc !== null &&
    typeof doc === "object" &&
    "format_version" in doc &&
    (doc as { format_version: unknown }).format_version !== 1
  ) {
    return {
      ok: false,
      error: error(
        "unsupported_capability",
        `unsupported format_version: ${String((doc as { format_version: unknown }).format_version)}`,
        { pointer: "/format_version" },
      ),
    };
  }

  if (!validateSchema(doc)) {
    const first = validateSchema.errors?.[0];
    const pointer = first ? pointerFromAjv(first) : null;
    const message = first
      ? ajv.errorsText(validateSchema.errors, { dataVar: "project" })
      : "invalid project document";
    return {
      ok: false,
      error: error("validation", message, { pointer }),
    };
  }

  const project = doc as ProjectDocument;

  if ((project.models ?? []).length > 0) {
    try {
      topoSortModels(project.models ?? []);
    } catch (err) {
      return { ok: false, error: err as CommandError };
    }
  }

  const chains = new Map(
    (project.chain_sources ?? []).map((c) => [c.id, c] as const),
  );
  for (const [index, source] of (project.event_sources ?? []).entries()) {
    if (source.end.mode !== "follow_finalized") continue;
    const chain = chains.get(source.chain);
    if (chain?.finality.policy === "confirmation_depth") {
      return {
        ok: false,
        error: error(
          "unsupported_capability",
          "follow_finalized requires finalized chain finality; confirmation_depth is unsupported",
          {
            resource_id: source.id,
            pointer: `/event_sources/${index}/end`,
          },
        ),
      };
    }
  }

  for (const query of project.queries ?? []) {
    const filePath = path.resolve(projectDir, query.file);
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        error: error("validation", `missing query file: ${query.file}`, {
          resource_id: query.id,
          pointer: "/queries",
        }),
      };
    }
  }

  for (const model of project.models ?? []) {
    const filePath = path.resolve(projectDir, model.file);
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        error: error("validation", `missing model file: ${model.file}`, {
          resource_id: model.id,
          pointer: "/models",
        }),
      };
    }
  }

  // Snapshot files are authored inputs for dataset-only projects. Ingest
  // projects materialize them at apply time, so their absence is not an error.
  const isIngest = (project.event_sources ?? []).length > 0;
  for (const dataset of project.datasets ?? []) {
    if (isIngest) break;
    const filePath = path.resolve(projectDir, dataset.snapshot);
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        error: error("validation", `missing snapshot file: ${dataset.snapshot}`, {
          resource_id: dataset.id,
          pointer: "/datasets",
        }),
      };
    }
  }

  return { ok: true, project };
}
