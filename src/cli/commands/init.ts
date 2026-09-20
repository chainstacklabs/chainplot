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

  // A scaffold is a directory someone will `git init` in. The .env it asks
  // them to create holds the RPC endpoint, and without this file nothing
  // stops it being committed alongside the run journal and the built release.
  fs.writeFileSync(path.join(dest, ".gitignore"), SCAFFOLD_GITIGNORE);

  // The template's own id is a placeholder. A project is named after the
  // directory it was created in, the way `git init` or `npm init` would.
  const projectId = projectIdFrom(path.basename(dest)) ?? id;
  const yamlPath = path.join(dest, "chainplot.yaml");
  const yaml = fs.readFileSync(yamlPath, "utf8");
  const idLines = yaml.match(/^id: .*$/gm) ?? [];
  if (idLines.length !== 1) {
    return validation(`template ${id} has ${idLines.length} top-level id lines; expected 1`);
  }
  fs.writeFileSync(yamlPath, yaml.replace(/^id: .*$/m, `id: ${JSON.stringify(projectId)}`));

  return okResult("init", { template: id, output: dest, id: projectId });
}

const SCAFFOLD_GITIGNORE = `# Written by chainplot init.
# The RPC endpoint lives here; never commit it.
.env
# Run journal, locks and exported snapshots; rebuilt by plan/apply.
.chainplot/
# Built release; rebuilt by build.
dist/
`;

/** A directory name reduced to the characters a project id may carry. */
export function projectIdFrom(dirName: string): string | null {
  const cleaned = dirName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}
