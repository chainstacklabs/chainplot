import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LatestPointer, PublishTarget } from "./target.js";
import { ENTRY_POINT_MARKER } from "./entryPoint.js";
import { CONTENT_TYPES } from "./serve.js";
import { commandError } from "../plan/errors.js";

export interface S3TargetEnv {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export function s3EnvFromProcess(
  env: NodeJS.ProcessEnv = process.env,
): S3TargetEnv | null {
  if (
    !env.CHAINPLOT_S3_ENDPOINT ||
    !env.CHAINPLOT_S3_BUCKET ||
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  // The client is path-style: the bucket becomes the first path segment of
  // every request. An endpoint that already carries a path (R2's console
  // shows `…/<bucket>` next to the account URL) makes the real bucket a
  // prefix on every key — uploads land one level too deep, publish reports
  // success, and the public URL serves nothing.
  let url: URL;
  try {
    url = new URL(env.CHAINPLOT_S3_ENDPOINT);
  } catch {
    throw commandError("validation", `CHAINPLOT_S3_ENDPOINT is not a URL: ${env.CHAINPLOT_S3_ENDPOINT}`, {
      pointer: "/env/CHAINPLOT_S3_ENDPOINT",
    });
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw commandError(
      "validation",
      `CHAINPLOT_S3_ENDPOINT must be an origin with no path: got ${env.CHAINPLOT_S3_ENDPOINT}. ` +
        `The bucket goes in CHAINPLOT_S3_BUCKET; a path here would be sent as the bucket.`,
      { pointer: "/env/CHAINPLOT_S3_ENDPOINT", suggested_next: `set CHAINPLOT_S3_ENDPOINT=${url.origin}` },
    );
  }
  return {
    endpoint: url.origin,
    bucket: env.CHAINPLOT_S3_BUCKET,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.CHAINPLOT_S3_REGION ?? "auto",
  };
}

export const LATEST_KEY = "latest.json";
const ENTRY_POINT_KEY = "index.html";
/**
 * Revalidate rather than reuse.
 *
 * The pointer changes on every publish and the page is what reads it, so a
 * cache that serves either without asking makes the stable URL show an older
 * release — the one thing it exists to prevent. `no-cache` still allows a
 * conditional request, so the usual answer is a 304 and almost no traffic.
 */
const MUST_REVALIDATE = "no-cache, must-revalidate";

// Minimal storage surface so unit tests can mock without the AWS SDK.
export interface S3Ops {
  put(
    key: string,
    body: string | Uint8Array,
    conditions?: {
      ifMatch?: string;
      ifNoneMatch?: string;
      contentType?: string;
      cacheControl?: string;
    },
  ): Promise<{ etag: string }>;
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
}

export function makeS3Ops(env: S3TargetEnv): S3Ops {
  const client = new S3Client({
    endpoint: env.endpoint,
    region: env.region ?? "auto",
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    forcePathStyle: true,
  });
  return {
    async put(key, body, conditions) {
      const input: {
        Bucket: string;
        Key: string;
        Body: string | Uint8Array;
        IfMatch?: string;
        IfNoneMatch?: string;
        ContentType?: string;
        CacheControl?: string;
      } = {
        Bucket: env.bucket,
        Key: key,
        Body: body,
      };
      if (conditions?.ifMatch !== undefined) input.IfMatch = conditions.ifMatch;
      if (conditions?.ifNoneMatch !== undefined) {
        input.IfNoneMatch = conditions.ifNoneMatch;
      }
      if (conditions?.contentType !== undefined) {
        input.ContentType = conditions.contentType;
      }
      if (conditions?.cacheControl !== undefined) {
        input.CacheControl = conditions.cacheControl;
      }
      try {
        const out = await client.send(new PutObjectCommand(input));
        return { etag: String(out.ETag ?? "") };
      } catch (err) {
        throw mapS3Error(err);
      }
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: env.bucket, Key: key }));
        return {
          body: await streamToBuffer(out.Body),
          etag: String(out.ETag ?? ""),
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw mapS3Error(err);
      }
    },
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: env.bucket, Key: key }));
        return { size: Number(out.ContentLength ?? 0), etag: String(out.ETag ?? "") };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw mapS3Error(err);
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
    },
  };
}

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

/**
 * Did a conditional write lose its race?
 *
 * Two shapes answer yes, and a caller that recovers from the race has to
 * accept both. `makeS3Ops` maps the SDK's 412 to a `policy_refused`
 * `CommandError` so a caller that simply lets it escape reports something a
 * reader can act on; that mapping is what an `S3Target` method actually
 * catches. The raw SDK shape still arrives from an injected `ops`. Knowing
 * that here, once, is what keeps a recovery path from being correct against a
 * test double and wrong against the bucket.
 */
function isPreconditionFailed(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  const name = (err as { name?: string })?.name;
  if (status === 412 || name === "PreconditionFailed") return true;
  // Within one conditional `put`, `policy_refused` has no other source.
  return (err as { code?: string })?.code === "policy_refused";
}

function mapS3Error(err: unknown): unknown {
  if (isPreconditionFailed(err)) {
    return commandError(
      "policy_refused",
      "conditional write refused (412): another writer changed the object concurrently",
      { retryable: false, suggested_next: "re-read latest.json and retry" },
    );
  }
  return err;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class S3Target implements PublishTarget {
  private readonly ops: S3Ops;
  private lastPointerETag: string | null = null;

  private readonly keyPrefix: string;

  constructor(env: S3TargetEnv, ops?: S3Ops, keyPrefix = "") {
    this.ops = ops ?? makeS3Ops(env);
    this.keyPrefix = keyPrefix;
  }

  /** The pointer key, namespaced when the target declares a prefix. */
  private latestKey(): string {
    return this.keyPrefix ? `${this.keyPrefix}/${LATEST_KEY}` : LATEST_KEY;
  }

  private entryPointKey(): string {
    return this.keyPrefix ? `${this.keyPrefix}/${ENTRY_POINT_KEY}` : ENTRY_POINT_KEY;
  }

  /**
   * The same page again at `<prefix>/`.
   *
   * An object store serves keys, so the bare directory URL only resolves if a
   * key of that exact name exists; a host that does resolve directories finds
   * `index.html` regardless, which makes this inert rather than wrong there.
   * Writing it travels with the bucket, unlike a rewrite rule configured at
   * whichever CDN happens to be in front of it today.
   */
  async promoteEntryAlias(html: string): Promise<boolean> {
    if (!this.keyPrefix) return false;
    const key = `${this.keyPrefix}/`;
    try {
      const existing = await this.ops.get(key);
      if (existing && !existing.body.toString("utf8").includes(ENTRY_POINT_MARKER)) {
        return false;
      }
      await this.ops.put(key, html, {
        contentType: "text/html; charset=utf-8",
        cacheControl: MUST_REVALIDATE,
        ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }),
      });
      return true;
    } catch (err) {
      if (isPreconditionFailed(err)) {
        const now = await this.ops.get(key);
        return now !== null && now.body.toString("utf8").includes(ENTRY_POINT_MARKER);
      }
      // A store that will not take a key ending in a separator simply does
      // not get the tidier URL. It is not a reason to fail a publish.
      return false;
    }
  }

  async promoteEntryPoint(html: string): Promise<boolean> {
    const key = this.entryPointKey();
    const existing = await this.ops.get(key);
    if (existing && !existing.body.toString("utf8").includes(ENTRY_POINT_MARKER)) {
      return false;
    }
    // Conditional, because reading and then writing is not one step: a site's
    // own index.html can appear between the two, and an unconditional put
    // would erase it. `If-None-Match` claims the key only if it is still
    // free; `If-Match` replaces only the page we just read.
    try {
      await this.ops.put(key, html, {
        contentType: "text/html; charset=utf-8",
        cacheControl: MUST_REVALIDATE,
        ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" }),
      });
    } catch (err) {
      if (!isPreconditionFailed(err)) throw err;
      // Someone wrote the key between the read and the write. If it was
      // another chainplot publisher the entry point exists and is correct —
      // the page names no release, so theirs and ours are the same bytes.
      // Only a foreign page means there is no entry point to report.
      const now = await this.ops.get(key);
      return now !== null && now.body.toString("utf8").includes(ENTRY_POINT_MARKER);
    }
    return true;
  }

  async uploadFiles(
    releaseDir: string,
    prefix: string,
    files: string[],
  ): Promise<void> {
    for (const rel of files) {
      const body = fs.readFileSync(path.join(releaseDir, rel));
      const ext = path.extname(rel).toLowerCase();
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      await this.ops.put(`${prefix}/${rel}`, new Uint8Array(body), {
        contentType,
      });
    }
  }

  async uploadExternal(localPath: string, key: string): Promise<void> {
    const body = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    await this.ops.put(key, new Uint8Array(body), {
      contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
    });
  }

  async verifyFiles(
    prefix: string,
    files: string[],
    checksums: Record<string, string>,
  ): Promise<void> {
    for (const rel of files) {
      const expected = checksums[rel];
      if (expected === undefined) continue;
      const head = await this.ops.head(`${prefix}/${rel}`);
      if (head === null) {
        throw commandError("transient_dependency", `verify failed: missing ${rel}`, {
          retryable: true,
        });
      }
      if (head.size <= 5 * 1024 * 1024) {
        const obj = await this.ops.get(`${prefix}/${rel}`);
        if (obj === null) {
          throw commandError("transient_dependency", `verify failed: missing ${rel}`, {
            retryable: true,
          });
        }
        const actual = createHash("sha256").update(obj.body).digest("hex");
        if (actual !== expected) {
          throw commandError("transient_dependency", `verify failed: checksum mismatch ${rel}`, {
            retryable: true,
          });
        }
      }
    }
  }

  async releaseExists(prefix: string): Promise<boolean> {
    return (await this.ops.head(`${prefix}/release.json`)) !== null;
  }

  async readLatest(): Promise<LatestPointer | null> {
    const obj = await this.ops.get(this.latestKey());
    if (obj === null) return null;
    this.lastPointerETag = obj.etag;
    return JSON.parse(obj.body.toString("utf8")) as LatestPointer;
  }

  async promoteLatest(pointer: LatestPointer): Promise<void> {
    const body = JSON.stringify(pointer, null, 2);
    const existing = await this.readLatest();
    try {
      if (existing) {
        await this.ops.put(this.latestKey(), body, {
          ifMatch: this.lastPointerETag ?? undefined,
          contentType: "application/json",
          cacheControl: MUST_REVALIDATE,
        });
      } else {
        await this.ops.put(this.latestKey(), body, {
          ifNoneMatch: "*",
          contentType: "application/json",
          cacheControl: MUST_REVALIDATE,
        });
      }
    } catch (err) {
      if (isPreconditionFailed(err)) {
        throw commandError(
          "policy_refused",
          "conditional write refused (412): another writer changed latest.json concurrently",
          { retryable: false, suggested_next: "re-read latest.json and retry" },
        );
      }
      throw err;
    }
  }
}

/**
 * The gate a live-only suite should ask: can these tests run here? A missing
 * variable and a malformed one are both no. `s3EnvFromProcess` distinguishes
 * them — right for a publish, which should say exactly what is wrong — but a
 * gate evaluated at module scope turns the second into a collection failure
 * with no test name on it, and CI never sees it because CI has no S3 env.
 */
export function s3EnvIfUsable(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof s3EnvFromProcess> {
  try {
    return s3EnvFromProcess(env);
  } catch {
    return null;
  }
}
