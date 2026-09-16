import fs from "node:fs";
import path from "node:path";

// Explicit allowlist (spec §16.1): sanitized recipe files only.
const ALLOWED_ENTRIES = [
  "chainplot.yaml",
  "abis",
  "models",
  "queries",
  "tests",
  "schemas",
] as const;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

export function copySourceBundle(
  projectDir: string,
  releaseDir: string,
): string[] {
  const destDir = path.join(releaseDir, "source");
  fs.mkdirSync(destDir, { recursive: true });
  const copied: string[] = [];
  for (const entry of ALLOWED_ENTRIES) {
    const src = path.join(projectDir, entry);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destDir, entry);
    fs.cpSync(src, dest, { recursive: true });
    if (fs.statSync(dest).isDirectory()) {
      for (const file of walkFiles(dest)) {
        copied.push(`source/${path.relative(destDir, file)}`);
      }
    } else {
      copied.push(`source/${entry}`);
    }
  }
  return copied;
}
