import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENTRY_POINT_MARKER,
  entryPointHtml,
  relativeReleasePath,
} from "../../src/publish/entryPoint.js";
import { DirectoryTarget } from "../../src/publish/directory.js";
import { S3Target, type S3Ops } from "../../src/publish/s3.js";
import { commandError } from "../../src/plan/errors.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-entry-"));
}

function preconditionError(): Error & { $metadata: { httpStatusCode: number } } {
  const err = new Error("precondition failed") as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = "PreconditionFailed";
  err.$metadata = { httpStatusCode: 412 };
  return err;
}

/**
 * What a refused conditional write actually looks like to an `S3Target`.
 *
 * `makeS3Ops` maps the SDK's 412 to this before any target method sees it, so
 * a recovery path tested only against the raw shape above is tested against a
 * case that the bucket never produces.
 */
function mappedPreconditionError(): unknown {
  return commandError(
    "policy_refused",
    "conditional write refused (412): another writer changed the object concurrently",
    { retryable: false, suggested_next: "re-read latest.json and retry" },
  );
}

/** Both shapes, for the paths that have to survive either. */
const REFUSALS: [string, () => unknown][] = [
  ["the SDK's 412", preconditionError],
  ["the mapped policy_refused", mappedPreconditionError],
];

function mockOps(
  refuse: () => unknown = preconditionError,
): S3Ops & { keys(): string[]; cacheOf(key: string): string | undefined } {
  const store = new Map<string, { body: string; etag: string; cache?: string }>();
  let counter = 0;
  return {
    async put(key, body, conditions) {
      const existing = store.get(key);
      if (conditions?.ifNoneMatch === "*" && existing) throw refuse();
      if (
        conditions?.ifMatch !== undefined &&
        (!existing || existing.etag !== conditions.ifMatch)
      ) {
        throw refuse();
      }
      const etag = `"e${++counter}"`;
      store.set(key, {
        body: typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
        etag,
        cache: conditions?.cacheControl,
      });
      return { etag };
    },
    async get(key) {
      const hit = store.get(key);
      return hit === undefined ? null : { body: Buffer.from(hit.body), etag: hit.etag };
    },
    async head(key) {
      const hit = store.get(key);
      return hit === undefined ? null : { size: hit.body.length, etag: hit.etag };
    },
    async delete(key) {
      store.delete(key);
    },
    keys: () => [...store.keys()],
    cacheOf: (key: string) => store.get(key)?.cache,
  };
}

const ENV = {
  endpoint: "https://example.r2.cloudflarestorage.com",
  bucket: "b",
  region: "auto",
  accessKeyId: "k",
  secretAccessKey: "s",
};

describe("relativeReleasePath", () => {
  it("strips the target prefix, leaving a path relative to the publish root", () => {
    expect(relativeReleasePath("arc-inflows/releases/abc123", "arc-inflows")).toBe(
      "releases/abc123",
    );
  });

  it("leaves the path alone when the target has no prefix", () => {
    expect(relativeReleasePath("releases/abc123", null)).toBe("releases/abc123");
    expect(relativeReleasePath("releases/abc123", "")).toBe("releases/abc123");
  });

  it("refuses a release that is not under the prefix", () => {
    expect(() => relativeReleasePath("other/releases/abc", "arc-inflows")).toThrow(
      /not under the target prefix/,
    );
  });

  // "arc" is a prefix of "arc-inflows" as a string but not as a path.
  it("does not treat a sibling prefix as a parent", () => {
    expect(() => relativeReleasePath("arc-inflows/releases/abc", "arc")).toThrow(
      /not under the target prefix/,
    );
  });
});

describe("entryPointHtml", () => {
  it("carries the marker that proves the page is ours", () => {
    expect(entryPointHtml("arc-inflows")).toContain(ENTRY_POINT_MARKER);
  });

  // The page names no release, which is what makes it impossible for the
  // entry point to fall behind the pointer.
  it("names no release, so republishing writes identical bytes", () => {
    expect(entryPointHtml("arc-inflows")).toBe(entryPointHtml("arc-inflows"));
    expect(entryPointHtml("arc-inflows")).not.toContain("releases/");
  });

  it("carries the prefix it has to strip from the pointer", () => {
    expect(entryPointHtml("arc-inflows")).toContain('PREFIX = "arc-inflows"');
    expect(entryPointHtml(null)).toContain('PREFIX = ""');
  });

  // A cached pointer is the staleness this page exists to avoid, and a
  // history entry here makes Back from the dashboard bounce forward again.
  it("reads the pointer uncached and replaces rather than pushes history", () => {
    const html = entryPointHtml("p");
    expect(html).toContain('cache: "no-store"');
    expect(html).toContain("location.replace(");
    expect(html).not.toContain("location.assign(");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("keeps the fallback hidden until a redirect has had time to happen", () => {
    const html = entryPointHtml("p");
    expect(html).toContain("visibility: hidden");
    expect(html).toMatch(/animation: reveal 0s \d+s forwards/);
  });

  it("does not ask a crawler to index the forwarding page", () => {
    expect(entryPointHtml("p")).toContain('name="robots" content="noindex"');
  });

  // The schema forbids these characters in a prefix, but the escaping must
  // not be what depends on that.
  it("cannot be escaped by a prefix carrying a script end tag", () => {
    const html = entryPointHtml("a</script><script>alert(1)</script>");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("<\\/script>");
  });
});

describe("DirectoryTarget.promoteEntryPoint", () => {
  it("writes the page at the publish root, under the prefix when there is one", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root, "arc-inflows");
    const html = entryPointHtml("arc-inflows");
    expect(await target.promoteEntryPoint(html)).toBe(true);
    expect(fs.readFileSync(path.join(root, "arc-inflows", "index.html"), "utf8")).toBe(html);
  });

  it("replaces a page it wrote before", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root, "");
    await target.promoteEntryPoint(entryPointHtml(null));
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(true);
    expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toContain(
      ENTRY_POINT_MARKER,
    );
  });

  // A bucket may already serve a site. Its front page is not ours to replace.
  it("refuses to overwrite an index.html chainplot did not write", async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "index.html"), "<html>someone else's site</html>");
    const target = new DirectoryTarget(root, "");
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(false);
    expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toBe(
      "<html>someone else's site</html>",
    );
  });

  // Claiming a free key uses link(), which fails rather than overwrites, so a
  // file that appears between the check and the write survives.
  it("does not clobber a file that appears after the check", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root, "");
    const realExists = fs.existsSync;
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      spy.mockRestore();
      const answer = realExists(p as string);
      fs.writeFileSync(path.join(root, "index.html"), "<html>someone else's site</html>");
      return answer;
    });
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(false);
    expect(fs.readFileSync(path.join(root, "index.html"), "utf8")).toBe(
      "<html>someone else's site</html>",
    );
    expect(fs.readdirSync(root).filter((f) => f.startsWith(".latest-tmp-"))).toEqual([]);
  });

  it("reports success when the file that appeared was another chainplot page", async () => {
    const root = tmp();
    const target = new DirectoryTarget(root, "");
    const realExists = fs.existsSync;
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      spy.mockRestore();
      const answer = realExists(p as string);
      fs.writeFileSync(path.join(root, "index.html"), entryPointHtml(null));
      return answer;
    });
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(true);
  });
});

describe("S3Target.promoteEntryPoint", () => {
  it("puts the page beside latest.json", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops, "arc-inflows");
    expect(await target.promoteEntryPoint(entryPointHtml("arc-inflows"))).toBe(true);
    expect(ops.keys()).toEqual(["arc-inflows/index.html"]);
  });

  it("replaces a page it wrote before", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops, "");
    await target.promoteEntryPoint(entryPointHtml(null));
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(true);
    const stored = await ops.get("index.html");
    expect(stored?.body.toString("utf8")).toContain(ENTRY_POINT_MARKER);
  });

  it("refuses to overwrite an index.html chainplot did not write", async () => {
    const ops = mockOps();
    await ops.put("index.html", "<html>someone else's site</html>", {});
    const target = new S3Target(ENV, ops, "");
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(false);
    const stored = await ops.get("index.html");
    expect(stored?.body.toString("utf8")).toBe("<html>someone else's site</html>");
  });

  // Reading and then writing is not one step. The conditional write is what
  // makes the ownership check mean anything.
  it("does not clobber a site index that appears after the check", async () => {
    const ops = mockOps();
    const bare = ops.get.bind(ops);
    let first = true;
    ops.get = async (key: string) => {
      const result = await bare(key);
      if (first) {
        first = false;
        await ops.put(key, "<html>someone else's site</html>", {});
      }
      return result;
    };
    const target = new S3Target(ENV, ops, "");
    expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(false);
    const stored = await ops.get("index.html");
    expect(stored?.body.toString("utf8")).toBe("<html>someone else's site</html>");
  });

  it("does not overwrite a page another publisher replaced after the check", async () => {
    const ops = mockOps();
    await ops.put("index.html", entryPointHtml(null), {});
    const bare = ops.get.bind(ops);
    let first = true;
    ops.get = async (key: string) => {
      const result = await bare(key);
      if (first) {
        first = false;
        await ops.put(key, `${entryPointHtml(null)}<!-- theirs -->`, {});
      }
      return result;
    };
    const target = new S3Target(ENV, ops, "");
    await target.promoteEntryPoint(entryPointHtml(null));
    const stored = await ops.get("index.html");
    expect(stored?.body.toString("utf8")).toContain("<!-- theirs -->");
  });

  // Losing to another chainplot publisher is not a failure: the page names no
  // release, so their bytes are ours. Reporting no entry point would be wrong.
  it.each(REFUSALS)(
    "reports success when the publisher that beat us was also chainplot (%s)",
    async (_shape, refuse) => {
      const ops = mockOps(refuse);
      const bare = ops.get.bind(ops);
      let first = true;
      ops.get = async (key: string) => {
        const result = await bare(key);
        if (first) {
          first = false;
          await ops.put(key, entryPointHtml(null), {});
        }
        return result;
      };
      const target = new S3Target(ENV, ops, "");
      expect(await target.promoteEntryPoint(entryPointHtml(null))).toBe(true);
    },
  );

  // A cached pointer or page is exactly the staleness the stable URL exists
  // to prevent, so both are written with a revalidate directive.
  it("writes the page and the pointer so a cache must revalidate", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops, "p");
    await target.promoteEntryPoint(entryPointHtml("p"));
    await target.promoteLatest({
      schema_version: 1,
      release_prefix: "p/releases/a",
      release_json_checksum: "x",
    });
    expect(ops.cacheOf("p/index.html")).toMatch(/no-cache/);
    expect(ops.cacheOf("p/latest.json")).toMatch(/no-cache/);
  });
});

describe("promoteEntryAlias", () => {
  it("writes the same page at the directory key", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops, "arc-inflows");
    const html = entryPointHtml("arc-inflows");
    expect(await target.promoteEntryAlias(html)).toBe(true);
    expect(ops.keys()).toEqual(["arc-inflows/"]);
    const stored = await ops.get("arc-inflows/");
    expect(stored?.body.toString("utf8")).toBe(html);
    expect(ops.cacheOf("arc-inflows/")).toMatch(/no-cache/);
  });

  // Without a prefix the directory key would be the empty string.
  it("has nothing to write when the target publishes to the root", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops, "");
    expect(await target.promoteEntryAlias(entryPointHtml(null))).toBe(false);
    expect(ops.keys()).toEqual([]);
  });

  it("leaves a foreign object at that key alone", async () => {
    const ops = mockOps();
    await ops.put("p/", "<html>someone else's site</html>", {});
    const target = new S3Target(ENV, ops, "p");
    expect(await target.promoteEntryAlias(entryPointHtml("p"))).toBe(false);
    const stored = await ops.get("p/");
    expect(stored?.body.toString("utf8")).toBe("<html>someone else's site</html>");
  });

  // Same race as the index.html key, same answer: their page is our page.
  // Returning false here would downgrade entry_url to the explicit name for a
  // bare URL that does in fact resolve.
  it.each(REFUSALS)(
    "reports success when another chainplot publisher claimed the key first (%s)",
    async (_shape, refuse) => {
      const ops = mockOps(refuse);
      const bare = ops.get.bind(ops);
      let first = true;
      ops.get = async (key: string) => {
        const result = await bare(key);
        if (first) {
          first = false;
          await ops.put(key, entryPointHtml("p"), {});
        }
        return result;
      };
      const target = new S3Target(ENV, ops, "p");
      expect(await target.promoteEntryAlias(entryPointHtml("p"))).toBe(true);
    },
  );

  // A store that refuses a key ending in a separator simply does not get the
  // tidier URL; index.html is already written and publishing must not fail.
  it("gives up quietly when the store will not take the key", async () => {
    const ops = mockOps();
    ops.put = async () => {
      throw new Error("InvalidArgument: key must not end with a separator");
    };
    const target = new S3Target(ENV, ops, "p");
    await expect(target.promoteEntryAlias(entryPointHtml("p"))).resolves.toBe(false);
  });

  it("a directory target has no such key", async () => {
    const target = new DirectoryTarget(tmp(), "p");
    expect(await target.promoteEntryAlias(entryPointHtml("p"))).toBe(false);
  });
});
