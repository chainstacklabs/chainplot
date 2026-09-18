import path from "node:path";
import {
  failResult,
  okResult,
  type CommandResult,
} from "../envelope.js";
import { startServe, validateServeDir } from "../../publish/serve.js";
import { isCommandError } from "./build.js";

let activeServer: { close(): void } | null = null;

/** Shut down the preview server, if one is running. Used by tests. */
export function closeActiveServer(): void {
  activeServer?.close();
  activeServer = null;
}

export async function serveCommand(
  cwd: string,
  dir?: string,
  port = 0,
  host = "127.0.0.1",
): Promise<CommandResult> {
  try {
    const target = path.resolve(cwd, dir ?? "dist/releases/local");
    validateServeDir(target);
    const handle = startServe(target, port, host);
    activeServer = handle;
    // The assigned port is only knowable once listen() has called back, so
    // reporting it before that yields the literal 0 the caller passed in.
    await handle.ready;
    // An unspecified bind address is not something a browser can open.
    const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const url = `http://${shownHost}:${handle.port}`;
    // Diagnostics to stderr; stdout stays reserved for the result envelope.
    process.stderr.write(`serving ${target} at ${url} (Ctrl+C to stop)\n`);
    const shutdown = () => {
      closeActiveServer();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return okResult("serve", { url, dir: target });
  } catch (err) {
    if (isCommandError(err)) return failResult("serve", err);
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return failResult("serve", {
        code: "validation",
        message: err.message,
        resource_id: null,
        pointer: null,
        retryable: false,
        suggested_next: "run build first",
      });
    }
    throw err;
  }
}
