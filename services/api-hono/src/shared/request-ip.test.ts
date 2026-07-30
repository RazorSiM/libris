import { describe, expect, it } from "vite-plus/test";
import type { Context } from "hono";
import type { AppVariables } from "../context.js";
import { getRequestIp } from "./request-ip.js";

function createMockContext({
  headers = {},
  remoteAddress = "10.0.0.5",
  trustProxyHeaders = "0",
}: {
  headers?: Record<string, string>;
  remoteAddress?: string;
  trustProxyHeaders?: "0" | "1";
}): Context<{ Variables: AppVariables }> {
  return {
    env: {
      incoming: {
        socket: {
          remoteAddress,
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
        return { TRUST_PROXY_HEADERS: trustProxyHeaders };
      }

      return undefined;
    },
  } as unknown as Context<{ Variables: AppVariables }>;
}

describe("getRequestIp", () => {
  it("uses the real connection address by default", () => {
    const c = createMockContext({
      headers: {
        "x-real-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.10, 203.0.113.20",
      },
      remoteAddress: "10.0.0.5",
    });

    expect(getRequestIp(c)).toBe("10.0.0.5");
  });

  it("uses trusted proxy headers when explicitly enabled", () => {
    const c = createMockContext({
      headers: {
        "x-real-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.10, 203.0.113.20",
      },
      remoteAddress: "10.0.0.5",
      trustProxyHeaders: "1",
    });

    expect(getRequestIp(c)).toBe("198.51.100.10");
  });

  it("uses the first forwarded hop when x-real-ip is absent", () => {
    const c = createMockContext({
      headers: {
        "x-forwarded-for": "203.0.113.10, 203.0.113.20",
      },
      remoteAddress: "10.0.0.5",
      trustProxyHeaders: "1",
    });

    expect(getRequestIp(c)).toBe("203.0.113.10");
  });

  it("falls back to the connection address when trusted proxy headers are missing", () => {
    const c = createMockContext({
      remoteAddress: "10.0.0.5",
      trustProxyHeaders: "1",
    });

    expect(getRequestIp(c)).toBe("10.0.0.5");
  });
});
