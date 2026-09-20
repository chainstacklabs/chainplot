import fs from "node:fs";
import path from "node:path";
import type { LatestPointer } from "./target.js";
import type { PublishTarget } from "./target.js";

const LATEST = "latest.json";
const TEMP_PREFIX = ".latest-tmp-";

export class DirectoryTarget implements PublishTarget {
  constructor(
    private readonly rootDir: string,
    private readonly keyPrefix = "",
  ) {}

  /** The pointer path, namespaced when the target declares a prefix. */
  private latestPath(): string {
    return path.join(this.rootDir, this.keyPrefix, LATEST);
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

  async promoteLatest(pointer: LatestPointer): Promise<void> {
    // Atomic on the same filesystem: write temp, rename over latest.json.
    const latest = this.latestPath();
    const temp = path.join(
      path.dirname(latest),
      `${TEMP_PREFIX}${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(pointer, null, 2)}\n`);
    fs.renameSync(temp, latest);
  }
}
