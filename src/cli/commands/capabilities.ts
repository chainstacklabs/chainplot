import { createRequire } from "node:module";
import { okResult, type CommandResult } from "../envelope.js";
import { SCHEMA_KINDS } from "./schemaShow.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

export interface CapabilitiesData {
  cli_version: string;
  schema_kinds: string[];
  commands: string[];
  sources: string[];
  publish_targets: string[];
  chart_types: string[];
  sql_modes: string[];
}

export function capabilities(): CommandResult<CapabilitiesData> {
  return okResult("capabilities", {
    cli_version: pkg.version,
    schema_kinds: [...SCHEMA_KINDS],
    commands: [
      "capabilities",
      "schema show",
      "templates list",
      "init",
      "validate",
      "dataset describe",
      "query",
      "test",
      "build",
      "plan",
      "apply",
      "refresh",
      "runs list",
      "runs show",
      "runs cancel",
      "serve",
      "publish",
      "doctor",
      "fork",
    ],
    sources: [],
    publish_targets: [],
    chart_types: ["line", "bar", "area", "kpi", "table"],
    sql_modes: ["snapshot"],
  });
}
