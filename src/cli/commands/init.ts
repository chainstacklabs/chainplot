import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failResult, okResult, type CommandResult } from "../envelope.js";
import { listTemplates } from "./templates.js";

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates",
);

function validation(
  message: string,
  pointer: string | null = null,
): CommandResult<null> {
  return failResult("init", {
    code: "validation",
    message,
    resource_id: null,
    pointer,
    retryable: false,
    suggested_next: null,
  });
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export function initTemplate(id: string, outputDir: string): CommandResult {
  const known = listTemplates().some((t) => t.id === id);
  if (!known) {
    return validation(`unknown template: ${id}`, "/template");
  }

  const templateDir = path.join(TEMPLATES_DIR, id);
  const dest = path.resolve(outputDir);

  if (fs.existsSync(dest)) {
    const entries = fs.readdirSync(dest);
    if (entries.length > 0) {
      const colliding = path.join(dest, entries[0]!);
      return validation(`output path already exists: ${colliding}`);
    }
  }

  for (const rel of walkFiles(templateDir)) {
    const target = path.join(dest, rel);
    if (fs.existsSync(target)) {
      return validation(`output path already exists: ${target}`);
    }
  }

  try {
    fs.cpSync(templateDir, dest, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `failed to copy template: ${id}`;
    return validation(message);
  }

  return okResult("init", { template: id, output: dest });
}
