import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CommandError } from "../cli/envelope.js";
import { errorMessage } from "../plan/errors.js";

function validation(message: string): CommandError {
  return {
    code: "validation",
    message,
    resource_id: null,
    pointer: null,
    retryable: false,
    suggested_next: null,
  };
}

export function loadProject(projectDir: string): unknown {
  const filePath = path.join(projectDir, "chainplot.yaml");
  if (!fs.existsSync(filePath)) {
    throw validation(`missing chainplot.yaml in ${projectDir}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return parseYaml(raw);
  } catch (err) {
    throw validation(errorMessage(err));
  }
}
