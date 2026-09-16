import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { commandError, errorMessage } from "../plan/errors.js";

export interface LocalLock {
  release(): void;
}

interface LockFile {
  token?: string;
  pid?: number;
  host?: string;
  heartbeat_at?: string;
}

/**
 * The holder rewrites its lock file on this interval, so an abandoned lock is
 * recognisable in seconds rather than by guessing how long a job might run.
 *
 * Judging by pid only works on the same host, and the CLI normally runs in a
 * container against a bind-mounted project — where every recreated container
 * has a different hostname, so pid liveness never applies. A heartbeat is the
 * signal that works from either side.
 */
const HEARTBEAT_MS = 10_000;

/** Missed heartbeats tolerated before the lock is considered abandoned. */
const STALE_AFTER_MS = HEARTBEAT_MS * 4;

function lockBody(token: string): string {
  return JSON.stringify({
    token,
    pid: process.pid,
    host: os.hostname(),
    heartbeat_at: new Date().toISOString(),
  });
}

function readLock(lockPath: string): LockFile | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

/**
 * Is an existing lock file abandoned?
 *
 * An unreadable file was written by a run that died mid-write. A live holder
 * on this host settles it outright. Otherwise the heartbeat decides.
 */
function isStale(lockPath: string, now: number): boolean {
  const body = readLock(lockPath);
  if (body === null) return true;

  if (body.host === os.hostname() && typeof body.pid === "number") {
    try {
      process.kill(body.pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  const beat = body.heartbeat_at ? Date.parse(body.heartbeat_at) : NaN;
  if (Number.isNaN(beat)) return true;
  return now - beat > STALE_AFTER_MS;
}

function writeExclusive(lockPath: string, body: string): void {
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
}

export function acquireLocalLock(cwd: string, name: string): LocalLock {
  const lockDir = path.join(cwd, ".chainplot", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${name}.lock`);
  const token = randomUUID();

  try {
    writeExclusive(lockPath, lockBody(token));
  } catch {
    // A killed run cannot clean up after itself, and an ingest is killed by
    // design when it exceeds its wall clock. Without takeover the first crash
    // would lock the project until someone deleted the file by hand.
    if (isStale(lockPath, Date.now())) {
      fs.rmSync(lockPath, { force: true });
      try {
        writeExclusive(lockPath, lockBody(token));
        return holder(lockPath, token);
      } catch {
        /* lost the race to another writer; fall through to refusal */
      }
    }
    throw commandError(
      "policy_refused",
      `another run holds lock ${name}; one active ingest/publish per project. ` +
        `If no run is active, delete ${lockPath}`,
      { resource_id: name, suggested_next: "runs list" },
    );
  }

  return holder(lockPath, token);
}

function holder(lockPath: string, token: string): LocalLock {
  let released = false;

  // Refresh while held. If the file no longer carries our token, another
  // writer has taken the lock over and we must stop touching it rather than
  // clobber theirs.
  const beat = setInterval(() => {
    if (released) return;
    if (readLock(lockPath)?.token !== token) {
      clearInterval(beat);
      return;
    }
    try {
      fs.writeFileSync(lockPath, lockBody(token));
    } catch {
      /* the directory went away; release will handle it */
    }
  }, HEARTBEAT_MS);
  // Never a reason to keep the process alive.
  beat.unref?.();

  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      // Only remove a lock that is still ours.
      if (readLock(lockPath)?.token === token) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

export async function acquireAdvisoryLock(
  databaseUrl: string,
  key: string,
): Promise<() => void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    throw commandError(
      "transient_dependency",
      `cannot reach postgres for advisory lock: ${errorMessage(err)}`,
      { retryable: true },
    );
  }
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [key],
  );
  if (!result.rows[0]?.locked) {
    await client.end();
    throw commandError(
      "policy_refused",
      "postgres advisory lock held by another writer",
      { resource_id: key },
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [key])
      .then(() => client.end())
      .catch(() => undefined);
  };
}
