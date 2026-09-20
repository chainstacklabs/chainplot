import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLocalLock } from "../../src/runtime/locks.js";

// An ingest is killed by design when it exceeds its wall clock, and a killed
// run cannot clean up after itself. Before staleness detection the first such
// kill locked the project permanently, with an error that did not even name
// the file to delete.

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chainplot-lock-"));
}

function lockPath(cwd: string, name = "ingest"): string {
  return path.join(cwd, ".chainplot", "locks", `${name}.lock`);
}

describe("local lock", () => {
  it("excludes a concurrent holder", () => {
    const cwd = project();
    const held = acquireLocalLock(cwd, "ingest");
    expect(() => acquireLocalLock(cwd, "ingest")).toThrow(/another run holds lock/);
    held.release();
    expect(() => acquireLocalLock(cwd, "ingest").release()).not.toThrow();
  });

  it("names the file to delete when it refuses", () => {
    const cwd = project();
    acquireLocalLock(cwd, "ingest");
    try {
      acquireLocalLock(cwd, "ingest");
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as { message: string }).message).toContain(lockPath(cwd));
    }
  });

  it("takes over a lock whose owner is gone on this host", () => {
    const cwd = project();
    acquireLocalLock(cwd, "ingest");
    // A pid that cannot be running; same host, so liveness is decisive.
    fs.writeFileSync(
      lockPath(cwd),
      JSON.stringify({ pid: 2 ** 22, host: os.hostname(), acquired_at: new Date().toISOString() }),
    );
    expect(() => acquireLocalLock(cwd, "ingest").release()).not.toThrow();
  });

  // The CLI normally runs in a container against a bind-mounted project, and
  // each recreated container has a different hostname — so pid liveness never
  // applies and the heartbeat is the only usable signal. Judging by total age
  // instead would have to assume how long a job might legitimately run.
  it("takes over a lock whose heartbeat has stopped", () => {
    const cwd = project();
    acquireLocalLock(cwd, "ingest");
    fs.writeFileSync(
      lockPath(cwd),
      JSON.stringify({
        token: "someone-else",
        pid: 1,
        host: "some-container",
        heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(() => acquireLocalLock(cwd, "ingest").release()).not.toThrow();
  });

  it("leaves a lock alone while its heartbeat is current", () => {
    const cwd = project();
    acquireLocalLock(cwd, "ingest");
    fs.writeFileSync(
      lockPath(cwd),
      JSON.stringify({
        token: "someone-else",
        pid: 1,
        host: "some-container",
        heartbeat_at: new Date().toISOString(),
      }),
    );
    expect(() => acquireLocalLock(cwd, "ingest")).toThrow(/another run holds lock/);
  });

  // A holder that has lost its lock to a takeover must not delete the new
  // holder's file on the way out.
  it("release does not remove a lock that now belongs to someone else", () => {
    const cwd = project();
    const mine = acquireLocalLock(cwd, "ingest");
    const theirs = JSON.stringify({
      token: "someone-else",
      pid: 1,
      host: "some-container",
      heartbeat_at: new Date().toISOString(),
    });
    fs.writeFileSync(lockPath(cwd), theirs);
    mine.release();
    expect(fs.existsSync(lockPath(cwd))).toBe(true);
    expect(fs.readFileSync(lockPath(cwd), "utf8")).toBe(theirs);
  });

  it("a fresh holder writes a heartbeat and its own identity", () => {
    const cwd = project();
    const held = acquireLocalLock(cwd, "ingest");
    const body = JSON.parse(fs.readFileSync(lockPath(cwd), "utf8")) as {
      token: string;
      pid: number;
      host: string;
      heartbeat_at: string;
    };
    expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pid).toBe(process.pid);
    expect(Date.now() - Date.parse(body.heartbeat_at)).toBeLessThan(5_000);
    held.release();
  });

  it("takes over a truncated lock file", () => {
    const cwd = project();
    acquireLocalLock(cwd, "ingest");
    fs.writeFileSync(lockPath(cwd), "{ not json");
    expect(() => acquireLocalLock(cwd, "ingest").release()).not.toThrow();
  });
});
