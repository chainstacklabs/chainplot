import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RpcError } from "../../rpc/client.js";
import { renderConfig } from "./renderConfig.js";
import type { RunHandle, RunOptions } from "../adapter.js";

const QUIT_TIMEOUT_MS = 10_000;

export interface RunExtras {
  fakeMode?: string;
}

export async function runBounded(
  job: Parameters<typeof renderConfig>[0],
  opts: RunOptions,
  extras: RunExtras = {},
): Promise<RunHandle> {
  fs.mkdirSync(job.workDir, { recursive: true });
  const configPath = path.join(job.workDir, "rindexer.yaml");
  fs.writeFileSync(configPath, renderConfig(job));

  const [bin, ...binArgs] = opts.rindexerBin.split(" ").filter(Boolean);
  const child = spawn(bin, [...binArgs, "start", "-p", job.workDir, "indexer"], {
    // Own process group so stopAndQuiesce can signal rindexer AND its children.
    detached: process.platform !== "win32",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      RPC_URL: job.rpcUrl,
      DATABASE_URL: job.databaseUrl,
      ...(extras.fakeMode !== undefined
        ? { FAKE_RINDEXER_MODE: extras.fakeMode }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle: RunHandle = {
    job,
    pid: child.pid ?? -1,
    completedLogSeen: false,
  };

  return await new Promise<RunHandle>((resolve, reject) => {
    let settled = false;
    let stderrTail = "";
    const finish = (err: RpcError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClock);
      if (err) {
        child.removeAllListeners("exit");
        child.kill("SIGTERM");
        if (stderrTail) {
          err.message += `; rindexer stderr: ${stderrTail.slice(-400)}`;
        }
        reject(err);
      } else {
        resolve(handle);
      }
    };

    const wallClock = setTimeout(() => {
      finish(
        new RpcError(
          true,
          `rpc job wall clock exceeded (${opts.wallClockMs}ms); job is resumable`,
        ),
      );
    }, opts.wallClockMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Historical indexing completed")) {
        handle.completedLogSeen = true;
        finish(null);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    child.on("error", (err) => {
      finish(new RpcError(true, `failed to spawn rindexer: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (handle.completedLogSeen) return;
      finish(
        new RpcError(
          true,
          `rindexer exited before historic completion (code=${code} signal=${signal})`,
        ),
      );
    });
  });
}

export async function stopAndQuiesce(handle: RunHandle): Promise<void> {
  if (handle.pid <= 0) return;
  // Negative pid signals the whole process group (rindexer forks children
  // that keep writing after the parent exits). Windows does not support negative PIDs.
  const group = process.platform === "win32" ? handle.pid : -handle.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {
    return; // already gone
  }
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    const poll = () => {
      try {
        process.kill(group, 0);
        if (Date.now() > deadline) {
          try {
            process.kill(group, "SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      } catch {
        resolve();
      }
    };
    poll();
  });
}
