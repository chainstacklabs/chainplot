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
  return {
    endpoint: env.CHAINPLOT_S3_ENDPOINT,
    bucket: env.CHAINPLOT_S3_BUCKET,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.CHAINPLOT_S3_REGION ?? "auto",
  };
}

export const LATEST_KEY = "latest.json";

// Minimal storage surface so unit tests can mock without the AWS SDK.
export interface S3Ops {
  put(
    key: string,
    body: string | Uint8Array,
    conditions?: { ifMatch?: string; ifNoneMatch?: string; contentType?: string },
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

function isPreconditionFailed(err: unknown): boolean {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  const name = (err as { name?: string })?.name;
  return status === 412 || name === "PreconditionFailed";
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
        });
      } else {
        await this.ops.put(this.latestKey(), body, {
          ifNoneMatch: "*",
          contentType: "application/json",
        });
  async releaseExists(prefix: string): Promise<boolean> {
    return (await this.ops.head(`${prefix}/release.json`)) !== null;
  }

      }
    } catch (err) {
      if ((err as { code?: string }).code === "policy_refused") throw err;
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
