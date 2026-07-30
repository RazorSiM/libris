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

    // Public auth routes — exact match
    ["/api/auth/login", "public"],
    ["/api/auth/logout", "public"],
    ["/api/auth/setup", "public"],
    ["/api/auth/session", "public"],

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

    it("matches /api/auth/login exactly, not as /api/ prefix", () => {
      // Exact match on /api/auth/login should return "public", not "api-key"
      expect(resolvePolicy("/api/auth/login")).toBe("public");
    });

    it("matches /api/health exactly as optional, not as /api/ prefix", () => {
      expect(resolvePolicy("/api/health")).toBe("optional");
    });

    it("does not match /api/auth/login/extra as an exact public route", () => {
      // Subpath should fall through to /api/ prefix → api-key
      expect(resolvePolicy("/api/auth/login/extra")).toBe("api-key");
    });

    it("matches /_docs via the /_ prefix rule, not the default", () => {
      expect(resolvePolicy("/_docs/scalar")).toBe("skip");
      expect(resolvePolicy("/_anything")).toBe("skip");
    });
  });
});
