import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { latestPointer, pointerChecksumMatches } from "../../src/publish/latestPointer.js";
import { DirectoryTarget } from "../../src/publish/directory.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-pub-"));
}

function makeRelease(root: string, id: string, body: string): string {
  const releaseDir = path.join(root, "releases", id);
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "release.json"), body);
  fs.writeFileSync(path.join(releaseDir, "index.html"), "<html></html>");
  return releaseDir;
}

describe("latestPointer", () => {
  it("checksum is sha256 of the release.json bytes", () => {
    const body = '{"schema_version":1}';
    const pointer = latestPointer("releases/r1", body);
    expect(pointer).toEqual({
      schema_version: 1,
      release_prefix: "releases/r1",
      release_json_checksum: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("checksumMatches verifies bytes", () => {
    const body = "abc";
    expect(pointerChecksumMatches(latestPointer("p", body), body)).toBe(true);
    expect(pointerChecksumMatches(latestPointer("p", body), "abd")).toBe(false);
  });
});

describe("DirectoryTarget", () => {
  it("publishes immutable files then promotes latest atomically", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root);
    const releaseDir = makeRelease(root, "r1", '{"v":1}');
    const body = fs.readFileSync(path.join(releaseDir, "release.json"), "utf8");

    await target.uploadFiles(releaseDir, "releases/r1", [
      "release.json",
      "index.html",
    ]);
    // immutable files exist under the prefix
    expect(
      fs.existsSync(path.join(root, "releases/r1/release.json")),
    ).toBe(true);
    // no pointer yet
    expect(await target.readLatest()).toBeNull();

    await target.promoteLatest(latestPointer("releases/r1", body));
    const pointer = await target.readLatest();
    expect(pointer?.release_prefix).toBe("releases/r1");
    // latest.json is at the root, never inside releases/<id>/
    expect(fs.existsSync(path.join(root, "latest.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(root, "releases/r1/latest.json")),
    ).toBe(false);
  });

  it("second publish flips the pointer; previous release untouched", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root);
    const r1 = makeRelease(root, "r1", '{"v":1}');
    const r2 = makeRelease(root, "r2", '{"v":2}');
    const body1 = fs.readFileSync(path.join(r1, "release.json"), "utf8");
    const body2 = fs.readFileSync(path.join(r2, "release.json"), "utf8");

    await target.uploadFiles(r1, "releases/r1", ["release.json", "index.html"]);
    await target.promoteLatest(latestPointer("releases/r1", body1));
    await target.uploadFiles(r2, "releases/r2", ["release.json", "index.html"]);
    await target.promoteLatest(latestPointer("releases/r2", body2));

    const pointer = await target.readLatest();
    expect(pointer?.release_prefix).toBe("releases/r2");
    // r1 still complete and usable
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "releases/r1/release.json"), "utf8")),
    ).toEqual({ v: 1 });
  });

  it("pointer checksum mismatch detected on read", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root);
    const releaseDir = makeRelease(root, "r1", "real-body");
    await target.uploadFiles(releaseDir, "releases/r1", ["release.json"]);
    await target.promoteLatest(latestPointer("releases/r1", "real-body"));
    // tamper with the release body after promotion
    fs.writeFileSync(path.join(root, "releases/r1/release.json"), "tampered");
    const pointer = await target.readLatest();
    const body = fs.readFileSync(
      path.join(root, "releases/r1/release.json"),
      "utf8",
    );
    expect(pointerChecksumMatches(pointer!, body)).toBe(false);
  });
});

// Two projects sharing one target previously overwrote each other's pointer:
// latest.json was a fixed key at the root, so whichever published last won and
// the other project's consumers silently followed the wrong release.
describe("prefixed targets", () => {
  it("keeps each project's latest.json separate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-prefix-"));
    const a = new DirectoryTarget(root, "project-a");
    const b = new DirectoryTarget(root, "project-b");

    await a.promoteLatest({
      schema_version: 1,
      release_prefix: "project-a/releases/aaaa",
      release_json_checksum: "a".repeat(64),
    });
    await b.promoteLatest({
      schema_version: 1,
      release_prefix: "project-b/releases/bbbb",
      release_json_checksum: "b".repeat(64),
    });

    expect((await a.readLatest())?.release_prefix).toBe("project-a/releases/aaaa");
    expect((await b.readLatest())?.release_prefix).toBe("project-b/releases/bbbb");
    expect(fs.existsSync(path.join(root, "project-a", "latest.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "project-b", "latest.json"))).toBe(true);
    // No stray pointer at the root to mislead a consumer.
    expect(fs.existsSync(path.join(root, "latest.json"))).toBe(false);
  });
});
