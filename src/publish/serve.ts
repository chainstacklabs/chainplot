import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { commandError } from "../plan/errors.js";

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".parquet": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ServeHandle {
  port: number;
  ready: Promise<void>;
  close(): void;
}

export function startServe(rootDir: string, port: number): ServeHandle {
  const root = path.resolve(rootDir);
  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(404).end("not found");
      return;
    }
    let filePath = resolved;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(port, "127.0.0.1", () => readyResolve?.());
  const handle: ServeHandle = {
    get port(): number {
      const address = server.address();
      return typeof address === "object" && address !== null
        ? address.port
        : port;
    },
    ready,
    close: () => server.close(),
  };
  return handle;
}

export function validateServeDir(dir: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw commandError("validation", `serve directory not found: ${dir}`);
  }
}
