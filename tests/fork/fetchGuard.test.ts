import { describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  isBlockedAddress,
  normalizeIpLiteral,
} from "../../src/fork/fetchGuard.js";

describe("normalizeIpLiteral", () => {
  it("decimal integer → dotted quad", () => {
    expect(normalizeIpLiteral("2130706433")).toBe("127.0.0.1");
  });
  it("hex → dotted quad", () => {
    expect(normalizeIpLiteral("0x7f000001")).toBe("127.0.0.1");
  });
  it("octal components → dotted quad", () => {
    expect(normalizeIpLiteral("0177.0.0.1")).toBe("127.0.0.1");
  });
  it("dotted quad unchanged", () => {
    expect(normalizeIpLiteral("192.168.1.1")).toBe("192.168.1.1");
  });
  it("hostname → null", () => {
    expect(normalizeIpLiteral("example.com")).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  it("blocks loopback, RFC1918, CGNAT, link-local, ULA, unspecified", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertAllowedUrl", () => {
  it("refuses http", async () => {
    await expect(
      assertAllowedUrl("http://example.com/release.json", {}),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses loopback literal and decimal form", async () => {
    await expect(
      assertAllowedUrl("https://127.0.0.1/release.json", {}),
    ).rejects.toMatchObject({ code: "policy_refused" });
    await expect(
      assertAllowedUrl("https://2130706433/release.json", {}),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("refuses private DNS resolution", async () => {
    await expect(
      assertAllowedUrl("https://localhost/release.json", {}),
    ).rejects.toMatchObject({ code: "policy_refused" });
  });

  it("escape hatch allows private networks", async () => {
    const result = await assertAllowedUrl("https://127.0.0.1/x", {
      allowPrivateNetworks: true,
    });
    expect(result.pinnedAddress).toBe("127.0.0.1");
  });

  it("public URL resolves and pins an address", async () => {
    const result = await assertAllowedUrl("https://example.com/release.json", {});
    expect(result.pinnedAddress).toBeTruthy();
    expect(isBlockedAddress(result.pinnedAddress!)).toBe(false);
  });
});
