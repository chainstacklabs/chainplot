export class RpcError extends Error {
  constructor(
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcClient {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function createRpcClient(
  url: string,
  fetchImpl: typeof fetch = fetch,
): RpcClient {
  let nextId = 1;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const id = nextId++;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new RpcError(true, `rpc request failed: ${String(err)}`);
      }
      if (!response.ok) {
        throw new RpcError(true, `rpc http status ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        throw new RpcError(false, `rpc response is not json: ${String(err)}`);
      }
      const envelope = body as {
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (envelope.error !== undefined && envelope.error !== null) {
        throw new RpcError(
          true,
          `rpc error ${envelope.error.code ?? ""}: ${envelope.error.message ?? "unknown"}`,
        );
      }
      if (!("result" in envelope)) {
        throw new RpcError(false, "rpc response missing result");
      }
      return envelope.result as T;
    },
  };
}
