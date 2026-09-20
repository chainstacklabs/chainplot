import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  S3Target,
  s3EnvFromProcess,
  s3EnvIfUsable,
  type S3Ops,
} from "../../src/publish/s3.js";

interface Stored {
  body: string | Uint8Array;
  etag: string;
}

function preconditionError(): Error & { $metadata: { httpStatusCode: number } } {
  const err = new Error("precondition failed") as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = "PreconditionFailed";
  err.$metadata = { httpStatusCode: 412 };
  return err;
}

function mockOps(): S3Ops & { failNextPut412: boolean } {
  const store = new Map<string, Stored>();
  let counter = 0;
  const self = {
    failNextPut412: false,
    async put(key, body, conditions) {
      if (self.failNextPut412) {
        self.failNextPut412 = false;
        throw preconditionError();
      }
      const existing = store.get(key);
      if (conditions?.ifNoneMatch === "*" && existing) throw preconditionError();
      if (
        conditions?.ifMatch !== undefined &&
        existing &&
        existing.etag !== conditions.ifMatch
      ) {
        throw preconditionError();
      }
      const etag = `"etag-${++counter}"`;
      store.set(key, { body, etag });
      return { etag };
    },
    async get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        body:
          typeof hit.body === "string"
            ? hit.body
            : Buffer.from(hit.body).toString("utf8"),
        etag: hit.etag,
      };
    },
    async head(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        size: typeof hit.body === "string" ? hit.body.length : hit.body.length,
        etag: hit.etag,
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return self;
}

const ENV = {
  endpoint: "http://localhost",
  bucket: "b",
  accessKeyId: "a",
  secretAccessKey: "s",
};

describe("S3Target with mocked ops", () => {
  it("first promote uses If-None-Match *, second uses If-Match", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops);
    expect(await target.readLatest()).toBeNull();
    await target.promoteLatest(latestPointerOf("releases/r1", "body1"));
    const pointer = await target.readLatest();
    expect(pointer?.release_prefix).toBe("releases/r1");
    await target.promoteLatest(latestPointerOf("releases/r2", "body2"));
    expect((await target.readLatest())?.release_prefix).toBe("releases/r2");
  });

  it("412 on conditional put → policy_refused", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops);
    await target.promoteLatest(latestPointerOf("releases/r1", "body1"));
    // Simulate a concurrent writer between our read and our conditional put.
    ops.failNextPut412 = true;
    await expect(
      target.promoteLatest(latestPointerOf("releases/r2", "body2")),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("verifyFiles detects checksum mismatch", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops);
    await ops.put("releases/r1/release.json", "body");
    await expect(
      target.verifyFiles("releases/r1", ["release.json"], {
        "release.json": createHash("sha256").update("other").digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "transient_dependency" });
  });

  it("verifyFiles passes on matching checksum", async () => {
    const ops = mockOps();
    const target = new S3Target(ENV, ops);
    await ops.put("releases/r1/release.json", "body");
    await target.verifyFiles("releases/r1", ["release.json"], {
      "release.json": createHash("sha256").update("body").digest("hex"),
    });
  });
});

import { latestPointer } from "../../src/publish/latestPointer.js";

function latestPointerOf(prefix: string, body: string) {
  return latestPointer(prefix, body);
}

// R2's console shows the bucket next to the account URL, and a path pasted
// into CHAINPLOT_S3_ENDPOINT is sent as the bucket by a path-style client:
// every key lands one level too deep, publish reports success, the public
// URL serves nothing.
describe("s3EnvFromProcess", () => {
  const base = {
    CHAINPLOT_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "a",
    AWS_SECRET_ACCESS_KEY: "s",
  };

  it("is null while any variable is missing", () => {
    expect(s3EnvFromProcess({ ...base })).toBeNull();
  });

  it("accepts an origin, with or without the trailing slash", () => {
    const endpoint = "https://acct.r2.cloudflarestorage.com";
    expect(s3EnvFromProcess({ ...base, CHAINPLOT_S3_ENDPOINT: endpoint })?.endpoint).toBe(endpoint);
    expect(s3EnvFromProcess({ ...base, CHAINPLOT_S3_ENDPOINT: `${endpoint}/` })?.endpoint).toBe(endpoint);
  });

  it("refuses an endpoint that carries a path, naming the fix", () => {
    expect(() =>
      s3EnvFromProcess({ ...base, CHAINPLOT_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/b" }),
    ).toThrow(/no path/);
    try {
      s3EnvFromProcess({ ...base, CHAINPLOT_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/b" });
    } catch (err) {
      expect((err as { suggested_next: string }).suggested_next).toBe(
        "set CHAINPLOT_S3_ENDPOINT=https://acct.r2.cloudflarestorage.com",
      );
    }
  });

  it("refuses something that is not a URL", () => {
    expect(() => s3EnvFromProcess({ ...base, CHAINPLOT_S3_ENDPOINT: "acct.r2.dev" })).toThrow(
      /not a URL/,
    );
  });
});

// A live suite's gate asks "can these tests run here?". A missing variable and
// a malformed one are both no — but one returned null and the other threw, and
// the throw happened at module scope, so the file failed collection with no
// test name attached. Same shape as gating the live e2e on RPC_URL being set.
describe("s3EnvIfUsable, the live-test gate", () => {
  const base = {
    CHAINPLOT_S3_BUCKET: "b",
    AWS_ACCESS_KEY_ID: "a",
    AWS_SECRET_ACCESS_KEY: "s",
  };

  it("is null when nothing is configured", () => {
    expect(s3EnvIfUsable({ ...base })).toBeNull();
  });

  it("is null when the endpoint is malformed, where the strict reader throws", () => {
    const env = { ...base, CHAINPLOT_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com/b" };
    expect(() => s3EnvFromProcess(env)).toThrow();
    expect(s3EnvIfUsable(env)).toBeNull();
  });

  it("still hands back a usable environment", () => {
    const endpoint = "https://acct.r2.cloudflarestorage.com";
    expect(s3EnvIfUsable({ ...base, CHAINPLOT_S3_ENDPOINT: endpoint })?.endpoint).toBe(endpoint);
  });
});
