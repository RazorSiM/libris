import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import type { Context } from "hono";
import type { AppVariables } from "../context.js";
import {
  betterAuthClientIpHeader,
  getCredentialRateLimitKey,
  getIpRateLimitKey,
  getRequestIp,
  sessionHeaders,
} from "./request-ip.js";

function createMockContext({
  headers = {},
  clientIp,
  remoteAddress = "10.0.0.5",
  trustProxyHeaders = "0",
  trustedProxies = [],
  nodeEnv = "production",
}: {
  headers?: Record<string, string>;
  clientIp?: string;
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
      raw: { headers: new Headers(headers) },
    },
    get(key: string) {
      if (key === "clientIp") return clientIp;
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
    const c = createMockContext({
      headers: { [betterAuthClientIpHeader]: "203.0.113.99" },
      clientIp: "192.0.2.10",
    });

    expect(sessionHeaders(c).get(betterAuthClientIpHeader)).toBe("192.0.2.10");
  });

  it("strips the header entirely when no client address was resolved", () => {
    // A request stack assembled without clientIpMiddleware — which only happens
    // in tests, but "leave the client's value alone" would be the one outcome
    // that is worse than having no address at all.
    const c = createMockContext({ headers: { [betterAuthClientIpHeader]: "203.0.113.99" } });

    expect(sessionHeaders(c).has(betterAuthClientIpHeader)).toBe(false);
  });

  it("leaves every other header on the request untouched", () => {
    const c = createMockContext({
      headers: { cookie: "libris.session=abc", "user-agent": "KOReader" },
      clientIp: "192.0.2.10",
    });
    const headers = sessionHeaders(c);

    expect(headers.get("cookie")).toBe("libris.session=abc");
    expect(headers.get("user-agent")).toBe("KOReader");
  });
});

/**
 * The invariant `sessionHeaders` exists to hold, checked against the source
 * rather than against one request path.
 *
 * lib/auth.ts points `advanced.ipAddress.ipAddressHeaders` at a single private
 * header, and everything downstream of that — session records, Better Auth's
 * own rate-limit buckets — is only as trustworthy as the promise that no
 * Request carrying a CLIENT-supplied value for it ever reaches Better Auth.
 *
 * That promise used to be kept by four independent open-coded copies of "clone
 * the headers, overwrite the private one". One of those copies was missing
 * from `lastAdminMiddleware`; a second one was still missing
 * from `reassignBooksOnRemoveUser` when this test was written. A behavioural
 * test can only ever cover the call sites someone thought to drive, which is
 * the same enumeration problem that produced the defect — so this scans every
 * source file instead. A fifth call site written the old way fails here on the
 * day it is added, whether or not any test exercises its route.
 */
describe("no Better Auth call may be handed client-supplied headers", () => {
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();

  const sources = sourceFiles.map((file) => ({
    file,
    text: readFileSync(new URL(file, `file://${srcDir}`), "utf8"),
  }));

  /** The text between a call's parentheses, given the index of the opening one. */
  function callArguments(text: string, openParen: number): string {
    let depth = 0;
    for (let index = openParen; index < text.length; index++) {
      if (text[index] === "(") depth++;
      else if (text[index] === ")" && --depth === 0) return text.slice(openParen + 1, index);
    }
    return text.slice(openParen + 1);
  }

  it("passes sessionHeaders(c) to every auth.api.* call that takes headers", () => {
    const violations: string[] = [];
    let checked = 0;

    for (const { file, text } of sources) {
      // `const credentialHeaders = sessionHeaders(c)` in routes/api/events.ts:
      // the socket outlives `c.req.raw`, so the Headers copy has to be bound to
      // a name before the upgrade completes. An alias of the correct call is
      // still the correct call.
      const aliases = new Set(
        Array.from(text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*sessionHeaders\(c\)/g)).map(
          (match) => match[1]!,
        ),
      );

      for (const call of text.matchAll(/\.api\s*\.\s*(\w+)\s*\(/g)) {
        const args = callArguments(text, call.index + call[0].length - 1);
        const headers = /(?:^|[\s{,])headers\s*:\s*([^,\n}]+)/.exec(args);
        if (!headers) continue;
        checked++;
        const expression = headers[1]!.trim().replace(/[,;]$/, "");
        if (expression === "sessionHeaders(c)" || aliases.has(expression)) continue;
        violations.push(`${file}: auth.api.${call[1]}({ headers: ${expression} })`);
      }
    }

    // Without this the whole test passes vacuously the day the regex stops
    // matching the codebase's call style.
    expect(checked, "found auth.api.* calls that pass headers").toBeGreaterThanOrEqual(3);
    // The pre-fix failure: lib/user-deletion.ts passed `c.req.raw.headers`.
    expect(violations).toEqual([]);
  });

  it("never routes the raw request headers into anything Better Auth reads", () => {
    // Catches the shapes the rule above cannot see — chiefly app.ts's
    // `new Request(c.req.raw, { headers })`, which feeds auth.handler rather
    // than auth.api.
    const violations = sources
      .filter(({ text }) => /headers\s*:\s*c\.req\.raw\.headers/.test(text))
      .map(({ file }) => file);

    expect(violations).toEqual([]);
  });

  it("builds the Better Auth catch-all's Request with sessionHeaders", () => {
    // The catch-all is the one call site that is a Request rather than an
    // options bag, so it has no `headers:` property to check if the option is
    // dropped altogether — silently restoring the client's own value.
    const appSource = sources.find(({ file }) => file === "app.ts");

    expect(appSource, "app.ts is in the scan").toBeDefined();
    expect(appSource!.text).toMatch(
      /new Request\(c\.req\.raw,\s*\{\s*headers:\s*sessionHeaders\(c\)\s*\}\)/,
    );
  });
});
