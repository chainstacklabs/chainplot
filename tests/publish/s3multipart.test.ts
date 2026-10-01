import { describe, expect, it } from "vitest";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { makeS3Ops } from "../../src/publish/s3.js";

// A dataset_referenced release uploads parquet in the hundreds of megabytes.
// As one PutObject, a single dropped TLS record anywhere in the stream fails
// the whole file, and publish with it. Large bodies go up in parts instead,
// each retried on its own.

const ENV = {
  endpoint: "http://localhost",
  bucket: "b",
  accessKeyId: "a",
  secretAccessKey: "s",
};

const MiB = 1024 * 1024;
const TUNING = { partSize: 5 * MiB, attempts: 3, backoffMs: 0 };

type Sent = { name: string; input: Record<string, unknown> };

function fakeClient(failPart?: { number: number; times: number }) {
  const sent: Sent[] = [];
  let failures = 0;
  return {
    sent,
    async send(command: { constructor: { name: string }; input: object }) {
      const name = command.constructor.name;
      const input = command.input as Record<string, unknown>;
      sent.push({ name, input });
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "u1" };
      if (command instanceof UploadPartCommand) {
        if (failPart && input.PartNumber === failPart.number && failures < failPart.times) {
          failures++;
          throw new Error("ssl3_read_bytes:ssl/tls alert bad record mac");
        }
        return { ETag: `"p${String(input.PartNumber)}"` };
      }
      if (command instanceof CompleteMultipartUploadCommand) return { ETag: '"whole"' };
      if (command instanceof PutObjectCommand) return { ETag: '"single"' };
      return {};
    },
  };
}

const names = (sent: Sent[]) => sent.map((s) => s.name);

describe("S3 uploads of large bodies", () => {
  it("sends a body under the threshold as one PutObject", async () => {
    const client = fakeClient();
    const ops = makeS3Ops(ENV, client, TUNING);
    const out = await ops.put("k", new Uint8Array(1024), { contentType: "application/json" });
    expect(out.etag).toBe('"single"');
    expect(names(client.sent)).toEqual(["PutObjectCommand"]);
  });

  it("splits a large body into ordered parts and completes with their ETags", async () => {
    const client = fakeClient();
    const ops = makeS3Ops(ENV, client, TUNING);
    const body = new Uint8Array(12 * MiB);
    body[0] = 1;
    body[12 * MiB - 1] = 2;
    const out = await ops.put("data.parquet", body, { contentType: "application/vnd.apache.parquet" });

    expect(out.etag).toBe('"whole"');
    expect(names(client.sent)).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
    ]);
    const create = client.sent[0]!.input;
    expect(create).toMatchObject({ Bucket: "b", Key: "data.parquet", ContentType: "application/vnd.apache.parquet" });
    const parts = client.sent.filter((s) => s.name === "UploadPartCommand").map((s) => s.input);
    expect(parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(parts.map((p) => (p.Body as Uint8Array).byteLength)).toEqual([5 * MiB, 5 * MiB, 2 * MiB]);
    expect((parts[0]!.Body as Uint8Array)[0]).toBe(1);
    expect((parts[2]!.Body as Uint8Array)[2 * MiB - 1]).toBe(2);
    expect(client.sent[4]!.input).toMatchObject({
      UploadId: "u1",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"p1"' },
          { PartNumber: 2, ETag: '"p2"' },
          { PartNumber: 3, ETag: '"p3"' },
        ],
      },
    });
  });

  it("retries a failed part without restarting the upload", async () => {
    const client = fakeClient({ number: 2, times: 2 });
    const ops = makeS3Ops(ENV, client, TUNING);
    await ops.put("data.parquet", new Uint8Array(12 * MiB));
    const partNumbers = client.sent
      .filter((s) => s.name === "UploadPartCommand")
      .map((s) => s.input.PartNumber);
    expect(partNumbers).toEqual([1, 2, 2, 2, 3]);
    expect(names(client.sent).filter((n) => n === "CreateMultipartUploadCommand")).toHaveLength(1);
    expect(names(client.sent).at(-1)).toBe("CompleteMultipartUploadCommand");
  });

  it("aborts the upload when a part keeps failing, and reports it as retryable", async () => {
    const client = fakeClient({ number: 2, times: 99 });
    const ops = makeS3Ops(ENV, client, TUNING);
    await expect(ops.put("data.parquet", new Uint8Array(12 * MiB))).rejects.toMatchObject({
      code: "transient_dependency",
      retryable: true,
    });
    expect(names(client.sent).at(-1)).toBe("AbortMultipartUploadCommand");
    expect(names(client.sent)).not.toContain("CompleteMultipartUploadCommand");
    const abort = client.sent.at(-1)!.input;
    expect(abort).toMatchObject({ Bucket: "b", Key: "data.parquet", UploadId: "u1" });
    expect(client.sent.filter((s) => s.input.PartNumber === 2)).toHaveLength(TUNING.attempts);
  });

  it("keeps a conditional write a single PutObject whatever its size", async () => {
    const client = fakeClient();
    const ops = makeS3Ops(ENV, client, TUNING);
    await ops.put("latest.json", new Uint8Array(12 * MiB), { ifNoneMatch: "*" });
    expect(names(client.sent)).toEqual(["PutObjectCommand"]);
  });
});

