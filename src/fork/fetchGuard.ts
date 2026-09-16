import { lookup } from "node:dns/promises";
import https from "node:https";
import type { RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import { commandError } from "../plan/errors.js";

export interface FetchGuardOptions {
  allowPrivateNetworks?: boolean; // default false; documented escape hatch
  maxBytes: number;
  timeoutMs?: number; // per request, default 30_000
}

export const FORK_LIMITS = {
  releaseJsonBytes: 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  perRequestTimeoutMs: 30_000,
};

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isBlockedIPv4(ip: string): boolean {
  return (
    inCidr4(ip, "0.0.0.0", 8) ||
    inCidr4(ip, "10.0.0.0", 8) ||
    inCidr4(ip, "100.64.0.0", 10) ||
    inCidr4(ip, "127.0.0.0", 8) ||
    inCidr4(ip, "169.254.0.0", 16) ||
    inCidr4(ip, "172.16.0.0", 12) ||
    inCidr4(ip, "192.168.0.0", 16)
  );
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]!);
  const firstGroup = parseInt(lower.split(":")[0] ?? "0", 16);
  if (Number.isNaN(firstGroup)) return false;
  const firstByte = (firstGroup >> 8) & 0xff;
  // fc00::/7 (ULA): first byte 0xfc-0xfd
  if ((firstByte & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local): first 10 bits = 1111111010 → fe80..febf in group 0
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;
  return false;
}

// Normalize non-dotted IP literal forms (decimal/hex/octal) to dotted quad.
export function normalizeIpLiteral(host: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    // reject leading-zero octal components like 0177.0.0.1
    if (/(^|\.)0\d/.test(host)) {
      const parts = host.split(".").map((p) => parseInt(p, 8));
      if (parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return parts.join(".");
      }
      return null;
    }
    return host;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = Number.parseInt(host, 16);
    return n >= 0 && n <= 0xffffffff ? intToIpv4(n >>> 0) : null;
  }
  if (/^\d+$/.test(host)) {
    const n = Number.parseInt(host, 10);
    return n >= 0 && n <= 0xffffffff ? intToIpv4(n >>> 0) : null;
  }
  return null;
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function isBlockedAddress(address: string): boolean {
  if (address.includes(":")) return isBlockedIPv6(address);
  return isBlockedIPv4(address);
}

export async function assertAllowedUrl(
  rawUrl: string,
  opts: FetchGuardOptions,
): Promise<{ url: string; pinnedAddress: string | null }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw commandError("validation", `invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw commandError("validation", `fork fetch requires https: got ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = normalizeIpLiteral(host);
  if (literal && isBlockedAddress(literal) && !opts.allowPrivateNetworks) {
    throw commandError("policy_refused", `fork fetch blocked address: ${host}`);
  }
  let pinnedAddress: string | null = literal;
  if (!literal) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw commandError("transient_dependency", `DNS resolution failed: ${host}`, {
        retryable: true,
      });
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address) && !opts.allowPrivateNetworks) {
        throw commandError(
          "policy_refused",
          `fork fetch blocked: ${host} resolves to private address ${address}`,
        );
      }
    }
    pinnedAddress = addresses[0]!.address;
  }
  return { url: rawUrl, pinnedAddress };
}

// HTTPS GET with: no redirects, pinned DNS, per-request timeout, byte cap.
export function guardedFetch(
  rawUrl: string,
  opts: FetchGuardOptions,
): Promise<{ body: Buffer; contentType: string | null }> {
  const timeoutMs = opts.timeoutMs ?? FORK_LIMITS.perRequestTimeoutMs;
  return assertAllowedUrl(rawUrl, opts).then(
    ({ pinnedAddress }) =>
      new Promise((resolve, reject) => {
        const url = new URL(rawUrl);
        const req = https.request(
          {
            hostname: pinnedAddress ?? url.hostname,
            port: url.port ? Number(url.port) : 443,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            servername: url.hostname,
            timeout: timeoutMs,
            headers: { host: url.hostname },
          } as import("node:https").RequestOptions,
          (res: import("node:http").IncomingMessage) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.destroy();
              reject(commandError("policy_refused", `fork fetch: redirect forbidden (${status})`));
              return;
            }
            if (status !== 200) {
              res.destroy();
              reject(commandError("transient_dependency", `fork fetch: HTTP ${status}`, {
                retryable: true,
              }));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > opts.maxBytes) {
                res.destroy();
                reject(
                  commandError(
                    "policy_refused",
                    `fork fetch exceeded byte cap (${opts.maxBytes})`,
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              resolve({
                body: Buffer.concat(chunks),
                contentType: res.headers["content-type"] ?? null,
              });
            });
            res.on("error", (err) =>
              reject(commandError("transient_dependency", `fork fetch failed: ${err.message}`, {
                retryable: true,
              })),
            );
          },
        );
        req.on("timeout", () => {
          const err = commandError(
            "transient_dependency",
            `fork fetch timed out after ${timeoutMs}ms`,
            { retryable: true },
          ) as unknown as Error;
          req.destroy(err);
        });
        req.on("error", (err) => reject(err));
        req.end();
      }),
  );
}
