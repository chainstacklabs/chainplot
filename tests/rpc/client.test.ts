import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRpcClient, RpcError } from "../../src/rpc/client.js";
import { getFinalizedHead, getHeader } from "../../src/rpc/heads.js";

let server: http.Server | null = null;
let port = 0;

async function startRpc(
  handler: (method: string, params: unknown[]) => unknown,
): Promise<string> {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      try {
        const result = handler(parsed.method, parsed.params ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: String(err) },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  server?.close();
  server = null;
});

describe("rpc client", () => {
  it("returns result and parses hex quantities", async () => {
    const url = await startRpc((method) =>
      method === "eth_getBlockByNumber" && JSON.stringify(method)
        ? {
            number: "0x10",
            hash: "0x" + "ab".repeat(32),
            parentHash: "0x" + "cd".repeat(32),
          }
        : null,
    );
    const client = createRpcClient(url);
    const header = await getHeader(client, 16);
    expect(header.number).toBe(16);
    expect(header.hash).toBe("0x" + "ab".repeat(32));
    expect(header.parentHash).toBe("0x" + "cd".repeat(32));
  });

  it("maps JSON-RPC error to retryable RpcError", async () => {
    const url = await startRpc((method) => {
      if (method === "eth_getBlockByNumber") throw new Error("boom");
      return null;
    });
    const client = createRpcClient(url);
    await expect(getHeader(client, 1)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("maps connection refused to retryable RpcError", async () => {
    const client = createRpcClient("http://127.0.0.1:1");
    await expect(getHeader(client, 1)).rejects.toBeInstanceOf(RpcError);
    await expect(getHeader(client, 1)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("finalized head returns block", async () => {
    const url = await startRpc((method, params) => {
      expect(method).toBe("eth_getBlockByNumber");
      expect(params[0]).toBe("finalized");
      expect(params[1]).toBe(false);
      return {
        number: "0x64",
        hash: "0x" + "11".repeat(32),
        parentHash: "0x" + "22".repeat(32),
      };
    });
    const client = createRpcClient(url);
    const head = await getFinalizedHead(client);
    expect(head.number).toBe(100);
  });

  it("finalized null result is non-retryable (no fallback)", async () => {
    const url = await startRpc(() => null);
    const client = createRpcClient(url);
    await expect(getFinalizedHead(client)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("missing block header is non-retryable (block vanished)", async () => {
    const url = await startRpc(() => null);
    const client = createRpcClient(url);
    await expect(getHeader(client, 5)).rejects.toMatchObject({
      retryable: false,
    });
  });
});
