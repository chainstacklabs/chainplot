import type { RpcClient } from "./client.js";
import { RpcError } from "./client.js";

export interface BlockHeader {
  number: number;
  hash: string;
  parentHash: string;
  /** Unix seconds. The block's own clock is the only honest "how fresh". */
  timestamp: number;
}

interface RawHeader {
  number: string;
  hash: string;
  parentHash: string;
  timestamp?: string;
}

function toHeader(raw: RawHeader): BlockHeader {
  if (
    typeof raw?.number !== "string" ||
    typeof raw?.hash !== "string" ||
    typeof raw?.parentHash !== "string"
  ) {
    throw new RpcError(false, "malformed block header from rpc");
  }
  return {
    number: Number(BigInt(raw.number)),
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp:
      typeof raw.timestamp === "string" ? Number(BigInt(raw.timestamp)) : 0,
  };
}

export async function getFinalizedHead(client: RpcClient): Promise<BlockHeader> {
  const raw = await client.call<RawHeader | null>("eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  if (raw === null) {
    throw new RpcError(
      false,
      "node cannot supply finalized block; refusing to fall back",
    );
  }
  return toHeader(raw);
}

export async function getHeader(
  client: RpcClient,
  blockNumber: number,
): Promise<BlockHeader> {
  const raw = await client.call<RawHeader | null>("eth_getBlockByNumber", [
    "0x" + blockNumber.toString(16),
    false,
  ]);
  if (raw === null) {
    throw new RpcError(false, `block ${blockNumber} vanished from the chain`);
  }
  return toHeader(raw);
}
