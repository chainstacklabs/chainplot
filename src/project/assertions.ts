import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  failResult,
  okResult,
  type CommandError,
  type CommandResult,
} from "../cli/envelope.js";
import { runQuery } from "../query/runQuery.js";
import { loadProject } from "./load.js";
import { validateProject } from "./validate.js";
import { errorMessage } from "../plan/errors.js";
import { DEFAULT_ROW_LIMIT } from "./limits.js";


export interface AssertionFile {
  dataset: string;
  query?: string;
  expect: {
    row_count?: number;
    columns?: string[];
  };
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

function isCommandError(err: unknown): err is CommandError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "resource_id" in err &&
    "pointer" in err &&
    "retryable" in err &&
    "suggested_next" in err
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssertion(
  doc: unknown,
  pointer: string,
): AssertionFile | CommandError {
  if (!isPlainObject(doc)) {
    return error("validation", "assertion must be an object", { pointer });
  }

  const allowed = new Set(["dataset", "query", "expect"]);
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      return error("validation", `unknown assertion field: ${key}`, {
        pointer,
      });
    }
  }

  if (typeof doc.dataset !== "string" || doc.dataset.length === 0) {
    return error("validation", "assertion requires dataset", { pointer });
  }

  if (doc.query !== undefined && typeof doc.query !== "string") {
    return error("validation", "query must be a string", { pointer });
  }

  if (!isPlainObject(doc.expect)) {
    return error("validation", "assertion requires expect object", { pointer });
  }

  const expectAllowed = new Set(["row_count", "columns"]);
  for (const key of Object.keys(doc.expect)) {
    if (!expectAllowed.has(key)) {
      return error("validation", `unknown expect field: ${key}`, { pointer });
    }
  }

  const expect: AssertionFile["expect"] = {};
  if (doc.expect.row_count !== undefined) {
    if (
      typeof doc.expect.row_count !== "number" ||
      !Number.isInteger(doc.expect.row_count)
    ) {
      return error("validation", "row_count must be an integer", { pointer });
    }
    expect.row_count = doc.expect.row_count;
  }
  if (doc.expect.columns !== undefined) {
    if (
      !Array.isArray(doc.expect.columns) ||
      !doc.expect.columns.every((c) => typeof c === "string")
    ) {
      return error("validation", "columns must be a string array", { pointer });
    }
    expect.columns = doc.expect.columns;
  }

  return {
    dataset: doc.dataset,
    ...(typeof doc.query === "string" ? { query: doc.query } : {}),
    expect,
  };
}

export async function runAssertions(
  projectDir: string,
): Promise<CommandResult> {
  const command = "test";
  try {
    const doc = loadProject(projectDir);
    const validated = validateProject(doc, projectDir);
    if (!validated.ok) {
      return failResult(command, validated.error);
    }

    const testsDir = path.join(projectDir, "tests");
    const files = fs.existsSync(testsDir)
      ? fs
          .readdirSync(testsDir)
          .filter((name) => name.endsWith(".yaml"))
          .sort()
          .map((name) => path.join("tests", name))
      : [];

    for (const relPath of files) {
      const absPath = path.join(projectDir, relPath);
      let raw: unknown;
      try {
        raw = parseYaml(fs.readFileSync(absPath, "utf8"));
      } catch (err) {
        return failResult(
          command,
          error(
            "validation",
            errorMessage(err),
            { pointer: relPath },
          ),
        );
      }
      const assertion = parseAssertion(raw, relPath);
      if ("code" in assertion && "message" in assertion) {
        return failResult(command, assertion);
      }

      const dataset = (validated.project.datasets ?? []).find(
        (d) => d.id === assertion.dataset,
      );
      if (!dataset) {
        return failResult(
          command,
          error("validation", `unknown dataset: ${assertion.dataset}`, {
            resource_id: assertion.dataset,
            pointer: relPath,
          }),
        );
      }

      const parquetPath = path.resolve(projectDir, dataset.snapshot);
      if (!fs.existsSync(parquetPath)) {
        return failResult(
          command,
          error("validation", `missing snapshot file: ${dataset.snapshot}`, {
            resource_id: dataset.id,
            pointer: relPath,
          }),
        );
      }

      const result = await runQuery({
        sql: `SELECT * FROM ${dataset.id}`,
        tables: { [dataset.id]: parquetPath },
        rawAmountColumns: [],
        rowLimit: DEFAULT_ROW_LIMIT,
      });

      if (
        assertion.expect.row_count !== undefined &&
        result.rows.length !== assertion.expect.row_count
      ) {
        return failResult(
          command,
          error(
            "validation",
            `row_count expected ${assertion.expect.row_count}, got ${result.rows.length}`,
            { resource_id: dataset.id, pointer: relPath },
          ),
        );
      }

      if (assertion.expect.columns !== undefined) {
        const actual = result.columns.map((c) => c.name);
        if (
          actual.length !== assertion.expect.columns.length ||
          actual.some((name, i) => name !== assertion.expect.columns![i])
        ) {
          return failResult(
            command,
            error(
              "validation",
              `columns expected [${assertion.expect.columns.join(", ")}], got [${actual.join(", ")}]`,
              { resource_id: dataset.id, pointer: relPath },
            ),
          );
        }
      }
    }

    return okResult(command, { assertions: files.length });
  } catch (err) {
    if (isCommandError(err)) {
      return failResult(command, err);
    }
    throw err;
  }
}
