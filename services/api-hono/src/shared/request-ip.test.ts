import { describe, expect, it } from "vite-plus/test";
import type { Context } from "hono";
import type { AppVariables } from "../context.js";
import {
  betterAuthClientIpHeader,
  getCredentialRateLimitKey,
  getIpRateLimitKey,
  getRequestIp,
  withTrustedClientIp,
} from "./request-ip.js";

function createMockContext({
  headers = {},
  remoteAddress = "10.0.0.5",
  trustProxyHeaders = "0",
  trustedProxies = [],
  nodeEnv = "production",
}: {
  headers?: Record<string, string>;
  remoteAddress?: string | null | undefined;
  trustProxyHeaders?: "0" | "1";
  trustedProxies?: string[];
  nodeEnv?: "development" | "production" | "test";
}): Context<{ Variables: AppVariables }> {
  return {
    env: {
      incoming: {
        socket: {
          remoteAddress: remoteAddress ?? undefined,
          remotePort: 12345,
          remoteFamily: "IPv4",
        },
      },
    },
    req: {
      header(name: string) {
        return headers[name.toLowerCase()] ?? headers[name] ?? undefined;
      },
    },
    get(key: string) {
      if (key === "env") {
        return {
          NODE_ENV: nodeEnv,
          TRUST_PROXY_HEADERS: trustProxyHeaders,
          LIBRIS_TRUSTED_PROXIES: trustedProxies,
        };
      }
      return undefined;
    },
  } as unknown as Context<{ Variables: AppVariables }>;
}

describe("getRequestIp", () => {
  it("ignores forged forwarded headers by default", () => {
    const c = createMockContext({
      headers: {
        "x-real-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.10, 203.0.113.20",
      },
    });
    expect(getRequestIp(c)).toBe("10.0.0.5");
  });

  it("ignores forwarded headers when the immediate peer is not trusted", () => {
    const c = createMockContext({
      headers: { "x-forwarded-for": "198.51.100.1" },
      trustProxyHeaders: "1",
      trustedProxies: ["10.0.1.0/24"],
    });
    expect(getRequestIp(c)).toBe("10.0.0.5");
  });

  it("walks a trusted proxy chain from right to left", () => {
    const c = createMockContext({
      headers: { "x-forwarded-for": "192.0.2.99, 198.51.100.7, 10.0.0.8" },
      remoteAddress: "10.0.0.5",
      trustProxyHeaders: "1",
      trustedProxies: ["10.0.0.0/24"],
    });
    expect(getRequestIp(c)).toBe("198.51.100.7");
  });

  it("accepts X-Real-IP only from a trusted peer", () => {
    const c = createMockContext({
      headers: { "x-real-ip": "198.51.100.10" },
      trustProxyHeaders: "1",
      trustedProxies: ["10.0.0.5"],
    });
    expect(getRequestIp(c)).toBe("198.51.100.10");
  });

  it("unwraps an IPv4-mapped peer from a dual-stack listener", () => {
    expect(getRequestIp(createMockContext({ remoteAddress: "::ffff:198.51.100.23" }))).toBe(
      "198.51.100.23",
    );
  });

  it("matches a trusted proxy CIDR when the peer arrives IPv4-mapped", () => {
    const c = createMockContext({
      headers: { "x-forwarded-for": "198.51.100.7" },
      remoteAddress: "::ffff:10.0.0.5",
      trustProxyHeaders: "1",
      trustedProxies: ["10.0.0.0/24"],
    });
    expect(getRequestIp(c)).toBe("198.51.100.7");
  });

  it("fails closed when a production request has no connection address", () => {
    expect(() => getRequestIp(createMockContext({ remoteAddress: null }))).toThrow(
      /Unable to determine client address/,
    );
  });

  it("uses loopback only for Hono's socketless test adapter", () => {
    expect(getRequestIp(createMockContext({ remoteAddress: null, nodeEnv: "test" }))).toBe(
      "127.0.0.1",
    );
  });
});

describe("rate-limit identities", () => {
  it("groups IPv6 addresses by /64 while preserving distinct networks", () => {
    expect(getIpRateLimitKey("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(getIpRateLimitKey("2001:db8:abcd:12:ffff::9")).toBe("2001:db8:abcd:12::/64");
    expect(getIpRateLimitKey("2001:db8:abcd:13::1")).not.toBe(
      getIpRateLimitKey("2001:db8:abcd:12::1"),
    );
    expect(getIpRateLimitKey("192.0.2.4")).toBe("192.0.2.4");
  });

  it("keeps IPv4 peers apart when a dual-stack listener reports them as ::ffff:", () => {
    // serve({ port }) binds :: with no host, so Node hands every IPv4 peer over
    // as an IPv4-mapped address. Before this was unwrapped, every one of them
    // expanded to 0:0:0:0:0:ffff:<hi>:<lo> and the /64 key was built from the
    // four leading zero groups — one shared bucket for the entire IPv4
    // internet, and a single-machine DoS against every IPv4 user at once.
    expect(getIpRateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(getIpRateLimitKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(getIpRateLimitKey("::ffff:203.0.113.9")).not.toBe(
      getIpRateLimitKey("::ffff:198.51.100.7"),
    );
    // Same address, three spellings, one bucket.
    expect(getIpRateLimitKey("::FFFF:203.0.113.9")).toBe("203.0.113.9");
    expect(getIpRateLimitKey("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(getIpRateLimitKey("[::ffff:203.0.113.9]")).toBe("203.0.113.9");
    // And it must not collapse onto a real IPv6 caller's /64 either.
    expect(getIpRateLimitKey("::ffff:203.0.113.9")).not.toBe(getIpRateLimitKey("::1"));
  });

  it("normalizes credential identifiers without exposing them in keys", () => {
    expect(getCredentialRateLimitKey(" User@Example.com ")).toBe(
      getCredentialRateLimitKey("user@example.com"),
    );
    expect(getCredentialRateLimitKey("user@example.com")).not.toContain("user@example.com");
  });
});

describe("Better Auth client header", () => {
  it("overwrites an attacker-supplied internal header", () => {
    const headers = withTrustedClientIp(
      new Headers({ [betterAuthClientIpHeader]: "203.0.113.99" }),
      "192.0.2.10",
    );
    expect(headers.get(betterAuthClientIpHeader)).toBe("192.0.2.10");
  });
});
