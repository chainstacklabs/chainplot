import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failResult, okResult, type CommandResult } from "../envelope.js";

export const SCHEMA_KINDS = [
  "project",
  "plan",
  "result",
  "progress",
  "release",
  "manifest",
  "latest",
  "coverage",
  "lock",
] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../schemas",
);

function isSchemaKind(kind: string): kind is SchemaKind {
  return (SCHEMA_KINDS as readonly string[]).includes(kind);
}

export function schemaShow(kind: string): CommandResult {
  const command = "schema show";
  if (!isSchemaKind(kind)) {
    return failResult(command, {
      code: "validation",
      message: `unknown schema kind: ${kind}`,
      resource_id: null,
      pointer: "/kind",
      retryable: false,
      suggested_next: null,
    });
  }

  const schemaPath = path.join(SCHEMAS_DIR, `${kind}.schema.json`);
  const raw = fs.readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(raw) as unknown;
  return okResult(command, schema);
}
