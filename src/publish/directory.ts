import fs from "node:fs";
import path from "node:path";
import type { LatestPointer } from "./target.js";
import type { PublishTarget } from "./target.js";
import { ENTRY_POINT_MARKER } from "./entryPoint.js";

const LATEST = "latest.json";
const TEMP_PREFIX = ".latest-tmp-";

/**
 * Stage a file next to where it is going, inside a directory of its own.
 *
 * `mkdtemp` is the platform's answer to the question this raises: it creates
 * the directory itself, with a name nobody can guess and permissions nobody
 * else can enter, so no symlink can be waiting at the path we are about to
 * write. Building a name by hand and opening it carefully gets to the same
 * place, but this is the version a reader does not have to check.
 *
 * Staging beside the destination rather than in the system temp directory
 * keeps the final step a rename within one filesystem, which is what makes
 * it atomic.
 */
function stage(destination: string, name: string, write: (tempPath: string) => void): {
  path: string;
  discard: () => void;
} {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const dir = fs.mkdtempSync(path.join(path.dirname(destination), TEMP_PREFIX));
  const tempPath = path.join(dir, name);
  try {
    write(tempPath);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { path: tempPath, discard: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ENTRY_POINT = "index.html";

export class DirectoryTarget implements PublishTarget {
  constructor(
    private readonly rootDir: string,
    private readonly keyPrefix = "",
  ) {}

  /** The pointer path, namespaced when the target declares a prefix. */
  private latestPath(): string {
    return path.join(this.rootDir, this.keyPrefix, LATEST);
  }

  /** The forwarding page, beside the pointer. */
  private entryPointPath(): string {
    return path.join(this.rootDir, this.keyPrefix, ENTRY_POINT);
  }

  async uploadFiles(
    releaseDir: string,
    prefix: string,
    files: string[],
  ): Promise<void> {
    for (const rel of files) {
      const src = path.join(releaseDir, rel);
      const dest = path.join(this.rootDir, prefix, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  async uploadExternal(localPath: string, key: string): Promise<void> {
    const dest = path.join(this.rootDir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(localPath, dest);
  }

  async verifyFiles(
    prefix: string,
    files: string[],
    checksums: Record<string, string>,
  ): Promise<void> {
    const { createHash } = await import("node:crypto");
    for (const rel of files) {
      const dest = path.join(this.rootDir, prefix, rel);
      if (!fs.existsSync(dest)) {
        throw new Error(`upload verification failed: missing ${rel}`);
      }
      const expected = checksums[rel];
      if (expected === undefined) continue;
      const actual = createHash("sha256")
        .update(fs.readFileSync(dest))
        .digest("hex");
      if (actual !== expected) {
        throw new Error(`upload verification failed: checksum mismatch ${rel}`);
      }
    }
  }

  async releaseExists(prefix: string): Promise<boolean> {
    return fs.existsSync(path.join(this.rootDir, prefix, "release.json"));
  }

  async readLatest(): Promise<LatestPointer | null> {
    const file = this.latestPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as LatestPointer;
  }

  async promoteEntryAlias(): Promise<boolean> {
    // A file cannot be named `<prefix>/`. Anything serving a directory of
    // files resolves the bare path to index.html by itself anyway.
    return false;
  }

  async promoteEntryPoint(html: string): Promise<boolean> {
    const entry = this.entryPointPath();
    const existed = fs.existsSync(entry);
    if (existed && !fs.readFileSync(entry, "utf8").includes(ENTRY_POINT_MARKER)) {
      return false;
    }
    // Temp-then-publish, so a reader never sees a half-written page.
    //
    // Claiming a free key is atomic below; replacing our own page is not,
    // because POSIX has no compare-and-replace. A foreign writer that
    // replaces our page between the marker read above and the rename below
    // loses its file. That window is a local directory being written by two
    // processes at once, which the S3 target rules out with a conditional
    // write and this one cannot; `docs/capabilities.md` says so rather than
    // claiming a guarantee that is not here.
    const staged = stage(entry, ENTRY_POINT, (temp) => fs.writeFileSync(temp, html));
    try {
      if (existed) {
        // Replacing our own page: rename overwrites, atomically.
        fs.renameSync(staged.path, entry);
      } else {
        // Claiming a free key: link fails if anything appeared since the
        // check above, so a site's own index.html is never erased.
        fs.linkSync(staged.path, entry);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Something appeared since the check. Another chainplot publisher wrote
      // the same bytes, which is the outcome we wanted; anything else means
      // there is no entry point to report.
      return (
        fs.existsSync(entry) &&
        fs.readFileSync(entry, "utf8").includes(ENTRY_POINT_MARKER)
      );
    } finally {
      staged.discard();
    }
    return true;
  }

  async promoteLatest(pointer: LatestPointer): Promise<void> {
    // Atomic on the same filesystem: write temp, rename over latest.json.
    const latest = this.latestPath();
    const staged = stage(latest, LATEST, (temp) =>
      fs.writeFileSync(temp, `${JSON.stringify(pointer, null, 2)}\n`),
    );
    try {
      fs.renameSync(staged.path, latest);
    } finally {
      staged.discard();
    }
  }
}
