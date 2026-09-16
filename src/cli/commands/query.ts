import fs from "node:fs";
import path from "node:path";
import { failResult, okResult, type CommandError, type CommandResult } from "../envelope.js";
import { loadProject } from "../../project/load.js";
import { validateProject } from "../../project/validate.js";
import { runQuery } from "../../query/runQuery.js";
import { rawAmountNames } from "../../project/columns.js";
import { rowLimitFor } from "../../project/limits.js";


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

export async function querySnapshot(
  cwd: string,
  file: string,
  snapshotId: string,
): Promise<CommandResult> {
  const command = "query";
  try {
    const doc = loadProject(cwd);
    const result = validateProject(doc, cwd);
    if (!result.ok) {
      return failResult(command, result.error);
    }

    const dataset = (result.project.datasets ?? []).find((d) => d.id === snapshotId);
    if (!dataset) {
      return failResult(
        command,
        error("validation", `unknown dataset: ${snapshotId}`, {
          resource_id: snapshotId,
          pointer: "/datasets",
        }),
      );
    }

    const sqlPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    if (!fs.existsSync(sqlPath)) {
      return failResult(command, error("validation", `missing SQL file: ${file}`));
    }

    // All datasets in scope, matching `build`.
    const tables = Object.fromEntries(
      (result.project.datasets ?? []).map((d) => [
        d.id,
        path.resolve(cwd, d.snapshot),
      ]),
    );
    const rawAmountColumns = (result.project.queries ?? [])
      .filter((q) => q.dataset === snapshotId)
      .flatMap((q) => rawAmountNames(q.raw_amount_columns));

    const models = result.project.models ?? [];
    let modelSql: { id: string; sql: string }[] | undefined;
    if (models.length > 0) {
      const { topoSortModels } = await import("../../project/modelGraph.js");
      const modelOrder = topoSortModels(models);
      modelSql = modelOrder.map((id) => {
        const m = models.find((mod) => mod.id === id)!;
        const f = path.resolve(cwd, m.file);
        return { id, sql: fs.readFileSync(f, "utf8") };
      });
    }

    const data = await runQuery({
      sql: fs.readFileSync(sqlPath, "utf8"),
      tables,
      rawAmountColumns,
      rowLimit: rowLimitFor(result.project),
      models: modelSql,
    });
    return okResult(command, { ...data, snapshot: dataset.snapshot });
  } catch (err) {
    if (isCommandError(err)) {
      return failResult(command, err);
    }
    throw err;
  }
}
