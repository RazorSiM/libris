import { describe, expect, it } from "vite-plus/test";
import { resolvePolicy } from "./route-policy";

describe("resolvePolicy", () => {
  const cases: [string, string][] = [
    // Dev/test routes — skip
    ["/__test/cleanup", "skip"],
    ["/__test/seed", "skip"],

    // Internal routes (Scalar, OpenAPI) — skip via "/_" prefix
    ["/_docs/scalar", "skip"],
    ["/_docs/openapi.json", "skip"],

    // Better Auth owns everything under /api/auth/ and does its own
    // authentication, so the middleware must stand aside for the whole prefix.
    ["/api/auth/ok", "skip"],
    ["/api/auth/sign-in/email", "skip"],
    ["/api/auth/sign-up/email", "skip"],
    ["/api/auth/get-session", "skip"],
    ["/api/auth/list-sessions", "skip"],
    ["/api/auth/admin/list-users", "skip"],
    ["/api/auth/api-key/create", "skip"],

    // Optional auth — exact match
    ["/api/health", "optional"],

    // Admin routes — prefix match on /api/jobs
    ["/api/jobs/status", "admin"],
    ["/api/books", "api-key"],
    ["/api/books/123", "api-key"],
    ["/api/users", "api-key"],

    // KoSync — prefix match on /kosync/
    ["/kosync/users/auth", "kosync"],
    ["/kosync/syncs/progress", "kosync"],

    // OPDS — prefix match on /opds
    ["/opds", "opds"],
    ["/opds/catalog", "opds"],

    // Default fallback — non-API paths skip auth
    ["/favicon.ico", "skip"],
    ["/index.html", "skip"],
    ["/_nuxt/chunk-abc.js", "skip"],
  ];

  it.each(cases)("resolves %s → %s", (path, expected) => {
    expect(resolvePolicy(path)).toBe(expected);
  });

  describe("ordering: first match wins", () => {
    it("matches /__test/ before /api/ even though both are prefixes", () => {
      // /__test/ appears before /api/ in the table — verify it wins
      expect(resolvePolicy("/__test/cleanup")).toBe("skip");
    });

    it("matches /api/health exactly as optional, not as /api/ prefix", () => {
      expect(resolvePolicy("/api/health")).toBe("optional");
    });

    it("skips every depth under /api/auth/, not just the first level", () => {
      // Better Auth nests plugin endpoints (/api/auth/admin/…,
      // /api/auth/api-key/…), so a rule that only covered one segment would
      // hand those to the api-key policy and 401 them.
      expect(resolvePolicy("/api/auth/a/b/c/d")).toBe("skip");
    });

    it("hands the whole /api/auth/ prefix to Better Auth, key routes included", () => {
      // The bespoke /api/auth/keys routes are gone (libris-5ng.11); the plugin's
      // own endpoints live under this prefix and authenticate themselves, so the
      // skip rule is now correct for everything beneath it.
      expect(resolvePolicy("/api/auth/keys")).toBe("skip");
      expect(resolvePolicy("/api/auth/api-key/create")).toBe("skip");
    });

    it("does not let the /api/auth/ rule leak onto sibling paths", () => {
      // /api/authors would be a real route; the prefix must not swallow it.
      expect(resolvePolicy("/api/authors")).toBe("api-key");
      expect(resolvePolicy("/api/auth-something")).toBe("api-key");
    });

    it("matches /_docs via the /_ prefix rule, not the default", () => {
      expect(resolvePolicy("/_docs/scalar")).toBe("skip");
      expect(resolvePolicy("/_anything")).toBe("skip");
    });
  });
});
