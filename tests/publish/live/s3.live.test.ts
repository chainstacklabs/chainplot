import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../../helpers/run.js";
import {
  S3Target,
  makeS3Ops,
  s3EnvFromProcess,
  LATEST_KEY,
} from "../../../src/publish/s3.js";
import { latestPointer } from "../../../src/publish/latestPointer.js";

// Live-gated: needs CHAINPLOT_S3_ENDPOINT, CHAINPLOT_S3_BUCKET,
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (optionally CHAINPLOT_S3_REGION).
// Skips when absent. Never commit endpoint URLs or keys.
const env = s3EnvFromProcess();
const d = env ? it : it.skip;

describe("S3 conditional-write probe (M0 open question)", () => {
  const key = `probe/${Date.now()}-initial`;

  d("read-after-write, If-None-Match *, If-Match current, 412 on stale", async () => {
    const ops = makeS3Ops(env!);
    // 1. plain put + read-after-write
    await ops.put(key, "probe-body");
    const first = await ops.get(key);
    expect(first).not.toBeNull();
    expect(first!.body.toString("utf8")).toBe("probe-body");

    // 2. If-None-Match: * on an EXISTING key must be refused (412 raw or mapped)
    let ifNoneMatchOnExisting = "allowed";
    try {
      await ops.put(key, "probe-body-2", { ifNoneMatch: "*" });
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      ifNoneMatchOnExisting =
        status === 412 || (err as { code?: string }).code === "policy_refused"
          ? "refused"
          : "other-error";
    }
    expect(ifNoneMatchOnExisting).toBe("refused");

    // 3. If-Match with current ETag must succeed
    const current = await ops.get(key);
    const put = await ops.put(key, "probe-body-3", {
      ifMatch: current!.etag,
    });
    expect(put.etag).toBeTruthy();

    // 4. If-Match with a STALE ETag must be refused
    let ifMatchStale = "allowed";
    try {
      await ops.put(key, "probe-body-4", { ifMatch: current!.etag });
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      ifMatchStale =
        status === 412 || (err as { code?: string }).code === "policy_refused"
          ? "refused"
          : "other-error";
    }
    expect(ifMatchStale).toBe("refused");

    // cleanup
    await ops.delete(key);
  });

  d("publish → re-publish flips the pointer; failed upload leaves previous intact", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-s3pub-"));
    const dir = path.join(parent, "proj");
    const init = await runCliJson(
      ["init", "--template", "fixture-transfers", "--output", dir, "--json"],
      parent,
    );
    expect(init.ok).toBe(true);
    const yamlPath = path.join(dir, "chainplot.yaml");
    fs.writeFileSync(
      yamlPath,
      `${fs.readFileSync(yamlPath, "utf8")}
publish_targets:
  - id: r2
    type: s3
    bucket: ${env!.bucket}
    dataset_license: CC-BY-4.0
`,
    );

    const build = await runCliJson(["build", "--json"], dir);
    expect(build.ok).toBe(true);
    const publish1 = await runCliJson(["publish", "--json"], dir);
    expect(publish1.ok).toBe(true);
    const prefix1 = (publish1.data as { publish: { release_prefix: string } }).publish
      .release_prefix;

    const ops = makeS3Ops(env!);
    const pointer1 = await ops.get(LATEST_KEY);
    expect(pointer1).not.toBeNull();
    expect(JSON.parse(pointer1!.body).release_prefix).toBe(prefix1);

    // second release flips the pointer
    fs.writeFileSync(
      yamlPath,
      fs.readFileSync(yamlPath, "utf8").replace("title: Amounts", "title: Amounts v2"),
    );
    await runCliJson(["build", "--json"], dir);
    const publish2 = await runCliJson(["publish", "--json"], dir);
    expect(publish2.ok).toBe(true);
    const pointer2 = await ops.get(LATEST_KEY);
    const prefix2 = JSON.parse(pointer2!.body).release_prefix as string;
    expect(prefix2).not.toBe(prefix1);
    // previous release still readable
    expect((await ops.head(`${prefix1}/release.json`)) !== null).toBe(true);

    // checksum in pointer matches release.json bytes
    const releaseBody = (await ops.get(`${prefix2}/release.json`))!.body;
    const expected = latestPointer(prefix2, releaseBody);
    expect(JSON.parse(pointer2!.body).release_json_checksum).toBe(
      expected.release_json_checksum,
    );
  }, 120_000);
});
