import { createHash } from "node:crypto";
import { commandError } from "../../src/plan/errors.js";
import {
  isReleaseNotFound,
  resolveRemoteRelease,
} from "../../src/fork/importRelease.js";
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliJson } from "../helpers/run.js";

const template = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates/fixture-transfers",
);

async function buildPublishedRelease(
  mode?: "results_only" | "dataset_referenced",
): Promise<{ project: string; published: string }> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-src-"));
  const project = path.join(parent, "proj");
  fs.cpSync(template, project, { recursive: true });
  fs.writeFileSync(
    path.join(project, "chainplot.yaml"),
    `${fs.readFileSync(path.join(project, "chainplot.yaml"), "utf8")}
publish_targets:
  - id: local-dir
    type: directory
    path: ./published
    dataset_license: CC-BY-4.0
`,
  );
  // Forking to rebuild needs the dataset, which is now opt-in.
  const buildArgs = ["build", "--mode", mode ?? "dataset_included", "--json"];
  expect((await runCliJson(buildArgs, project)).ok).toBe(true);
  expect((await runCliJson(["publish", "--json"], project)).ok).toBe(true);
  return { project, published: path.join(project, "published") };
}

describe("fork", () => {
  it("local fork from publish root → new project validates + builds offline (A10)", async () => {
    const { published } = await buildPublishedRelease();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-out-"));
    const out = path.join(parent, "forked");

    const result = await runCliJson(
      ["fork", "--from", published, "--output", out, "--json"],
      parent,
    );
    expect(result.ok).toBe(true);

    // No secrets, no run state copied.
    expect(fs.existsSync(path.join(out, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(out, ".chainplot"))).toBe(false);

    // Forked project validates and builds offline over the pinned snapshot.
    const validated = await runCliJson(["validate", "--json"], out);
    expect(validated.ok).toBe(true);
    const built = await runCliJson(["build", "--json"], out);
    expect(built.ok).toBe(true);
    const release = JSON.parse(
      fs.readFileSync(path.join(out, "dist/releases/local/release.json"), "utf8"),
    ) as { mode: string; queries: string[] };
    // What A10 asserts is that the fork recomputes from the imported snapshot
    // with no RPC, credentials or reindexing. Whether it then republishes that
    // snapshot is the forker's own decision, so its release takes the default
    // rather than inheriting the producer's.
    expect(release.mode).toBe("results_only");
    expect(release.queries).toContain("raw_amounts");
    // The author's bucket is theirs: a fork must not aim `publish` at it.
    const forkedYaml = fs.readFileSync(path.join(out, "chainplot.yaml"), "utf8");
    expect(forkedYaml).not.toMatch(/publish_targets/);
    expect(result.warnings).toEqual([expect.stringMatching(/publish_targets dropped/)]);
    const results = JSON.parse(
      fs.readFileSync(
        path.join(out, "dist/releases/local/results/raw_amounts.json"),
        "utf8",
      ),
    ) as { rows: unknown[][] };
    expect(results.rows.length).toBe(8);
  }, 30_000);

  it("checksum mismatch → policy_refused", async () => {
    const { published } = await buildPublishedRelease();
    // Tamper with a published file.
    const pointer = JSON.parse(
      fs.readFileSync(path.join(published, "latest.json"), "utf8"),
    );
    const tamperPath = path.join(published, pointer.release_prefix, "release.json");
    const body = JSON.parse(fs.readFileSync(tamperPath, "utf8"));
    body.generated_at = "tampered";
    fs.writeFileSync(tamperPath, JSON.stringify(body, null, 2));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-out-"));
    const result = await runCliJson(
      ["fork", "--from", published, "--output", path.join(parent, "f"), "--json"],
      parent,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
  });

  it("http source refused", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-out-"));
    const result = await runCliJson(
      ["fork", "--from", "http://example.com/release.json", "--output", path.join(parent, "f"), "--json"],
      parent,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });

  it("missing source → validation", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-out-"));
    const result = await runCliJson(
      ["fork", "--from", "/nonexistent-xyz", "--output", path.join(parent, "f"), "--json"],
      parent,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation");
  });
});

// A results-only release carries the recipe and the rendered answers but no
// dataset. Forking one succeeded silently and the next `build` then failed
// with a bare "missing snapshot file" — a broken project and no explanation.
describe("forking a release without its dataset", () => {
  it("warns that there is no snapshot to build from", async () => {
    const { published } = await buildPublishedRelease("results_only");
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-ro-"));
    const out = path.join(parent, "forked");

    const result = await runCliJson(
      ["fork", "--from", published, "--output", out, "--json"],
      parent,
    );
    expect(result.ok).toBe(true);
    expect((result.data as { mode: string }).mode).toBe("results_only");
    expect(result.warnings.join(" ")).toMatch(/no snapshot/i);
    // The recipe and the published answers do come across; only the dataset
    // is absent, which is exactly what the warning has to convey.
    expect(fs.existsSync(path.join(out, "chainplot.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(out, "results"))).toBe(true);
    expect(fs.existsSync(path.join(out, "datasets/amounts/tables"))).toBe(false);
  });

  it("stays silent when the dataset is included", async () => {
    const { published } = await buildPublishedRelease();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-di-"));
    const out = path.join(parent, "forked");
    const result = await runCliJson(
      ["fork", "--from", published, "--output", out, "--json"],
      parent,
    );
    expect(result.ok).toBe(true);
    // The only warning is the one every fork of this fixture gets: its
    // publish target was the producer's and did not come across.
    expect(result.warnings).toEqual([expect.stringMatching(/publish_targets dropped/)]);
  });
});

// dataset_referenced used to record the producer's own filesystem path, which
// meant nothing to anyone else, and `fork` ignored the field entirely — so the
// mode was decorative. The reference is now release-relative: `publish` puts
// the parquet beside the release and `fork` fetches it from the same base.
describe("a referenced dataset round-trips", () => {
  it("publishes beside the release, and a fork pulls it in and rebuilds", async () => {
    const { project, published } = await buildPublishedRelease("dataset_referenced");

    // The release itself does not carry the parquet...
    const pointer = JSON.parse(
      fs.readFileSync(path.join(published, "latest.json"), "utf8"),
    ) as { release_prefix: string };
    const releaseDir = path.join(published, pointer.release_prefix);
    const release = JSON.parse(
      fs.readFileSync(path.join(releaseDir, "release.json"), "utf8"),
    ) as { mode: string; files: { path: string }[] };
    expect(release.mode).toBe("dataset_referenced");
    expect(release.files.some((f) => f.path.endsWith(".parquet"))).toBe(false);

    // ...but the manifest names it, release-relative, and publish put it there.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(releaseDir, "datasets/amounts/manifest.json"), "utf8"),
    ) as { external: { path: string; checksum: string; bytes: number } };
    expect(manifest.external.path).toBe("datasets/amounts/tables/amounts.parquet");
    expect(manifest.external.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(releaseDir, manifest.external.path))).toBe(true);

    // A fork fetches it, verifies it, and can recompute offline.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-ref-"));
    const out = path.join(parent, "forked");
    const forked = await runCliJson(
      ["fork", "--from", published, "--output", out, "--json"],
      parent,
    );
    expect(forked.ok).toBe(true);
    expect((forked.data as { datasets_referenced: string[] }).datasets_referenced).toEqual([
      "datasets/amounts/tables/amounts.parquet",
    ]);
    // The data did come across, so the only warning is the dropped target.
    expect(forked.warnings).toEqual([expect.stringMatching(/publish_targets dropped/)]);

    const built = await runCliJson(["build", "--json"], out);
    expect(built.ok).toBe(true);
    const results = JSON.parse(
      fs.readFileSync(
        path.join(out, "dist/releases/local/results/raw_amounts.json"),
        "utf8",
      ),
    ) as { rows: unknown[][] };
    expect(results.rows).toHaveLength(8);
    void project;
  }, 60_000);

  it("refuses a referenced dataset whose bytes do not match the manifest", async () => {
    const { published } = await buildPublishedRelease("dataset_referenced");
    const pointer = JSON.parse(
      fs.readFileSync(path.join(published, "latest.json"), "utf8"),
    ) as { release_prefix: string };
    const planted = path.join(
      published,
      pointer.release_prefix,
      "datasets/amounts/tables/amounts.parquet",
    );
    fs.writeFileSync(planted, "not the dataset you published");

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-fork-bad-"));
    const result = await runCliJson(
      ["fork", "--from", published, "--output", path.join(parent, "forked"), "--json"],
      parent,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_refused");
    expect(result.error?.message).toMatch(/checksum mismatch for referenced dataset/);
  }, 60_000);
});

describe("resolving a remote --from", () => {
  const releaseBody = Buffer.from(JSON.stringify({ schema_version: 1, mode: "results_only" }));
  const checksum = createHash("sha256").update(releaseBody).digest("hex");
  const notFound = () =>
    commandError("transient_dependency", "fork fetch: HTTP 404", { retryable: true });

  it("takes a release directory directly, with no prefix", async () => {
    const seen: string[] = [];
    const got = await resolveRemoteRelease("https://x/rel", async (url) => {
      seen.push(url);
      return releaseBody;
    });
    expect(seen).toEqual(["https://x/rel/release.json"]);
    expect(got).toEqual({ body: releaseBody, prefix: null });
  });

  it("falls back to latest.json when the release is not there", async () => {
    const seen: string[] = [];
    const got = await resolveRemoteRelease("https://x/root", async (url) => {
      seen.push(url);
      if (url.endsWith("/root/release.json")) throw notFound();
      if (url.endsWith("/latest.json")) {
        return Buffer.from(
          JSON.stringify({ release_prefix: "releases/abc", release_json_checksum: checksum }),
        );
      }
      return releaseBody;
    });
    expect(seen).toEqual([
      "https://x/root/release.json",
      "https://x/root/latest.json",
      "https://x/root/releases/abc/release.json",
    ]);
    expect(got.prefix).toBe("releases/abc");
  });

  it("refuses a release that does not match the pointer checksum", async () => {
    await expect(
      resolveRemoteRelease("https://x/root", async (url) => {
        if (url.endsWith("/root/release.json")) throw notFound();
        if (url.endsWith("/latest.json")) {
          return Buffer.from(
            JSON.stringify({ release_prefix: "releases/abc", release_json_checksum: "deadbeef" }),
          );
        }
        return releaseBody;
      }),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("does not fall back on an error that is not a 404", async () => {
    await expect(
      resolveRemoteRelease("https://x/root", async () => {
        throw commandError("transient_dependency", "fork fetch: HTTP 500", { retryable: true });
      }),
    ).rejects.toMatchObject({ message: "fork fetch: HTTP 500" });
  });

  // The 404 is only distinguishable by the message guardedFetch builds, so
  // pin that coupling here: change the wording there and this fails.
  it("recognises the 404 that guardedFetch actually throws", () => {
    expect(isReleaseNotFound(notFound())).toBe(true);
    expect(isReleaseNotFound(new Error("something else"))).toBe(false);
  });
});

describe("latest.json prefixes are bucket-relative", () => {
  const body = Buffer.from(JSON.stringify({ schema_version: 1 }));
  const sum = createHash("sha256").update(body).digest("hex");
  const notFound = () =>
    commandError("transient_dependency", "fork fetch: HTTP 404", { retryable: true });

  // What R2 actually serves: --from is the publish root, and the pointer
  // repeats that prefix because it is written relative to the bucket.
  it("does not repeat the prefix the publish root already carries", async () => {
    const seen: string[] = [];
    const got = await resolveRemoteRelease("https://h/fomo-rh", async (url) => {
      seen.push(url);
      if (url === "https://h/fomo-rh/release.json") throw notFound();
      if (url === "https://h/fomo-rh/latest.json") {
        return Buffer.from(
          JSON.stringify({
            release_prefix: "fomo-rh/releases/abc",
            release_json_checksum: sum,
          }),
        );
      }
      return body;
    });
    expect(seen).toContain("https://h/fomo-rh/releases/abc/release.json");
    expect(seen).not.toContain("https://h/fomo-rh/fomo-rh/releases/abc/release.json");
    expect(got.prefix).toBe("releases/abc");
  });

  it("still works from the bucket root, where nothing is shared", async () => {
    const seen: string[] = [];
    const got = await resolveRemoteRelease("https://h", async (url) => {
      seen.push(url);
      if (url === "https://h/release.json") throw notFound();
      if (url === "https://h/latest.json") {
        return Buffer.from(
          JSON.stringify({ release_prefix: "fomo-rh/releases/abc", release_json_checksum: sum }),
        );
      }
      return body;
    });
    expect(seen).toContain("https://h/fomo-rh/releases/abc/release.json");
    expect(got.prefix).toBe("fomo-rh/releases/abc");
  });
});
