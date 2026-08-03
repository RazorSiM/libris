import { describe, expect, it } from "vite-plus/test";
import { deniesAppPasswords, resolvePolicy } from "./route-policy";

describe("resolvePolicy", () => {
  const cases: [string, string][] = [
    // Test-support routes use a dedicated secret
    ["/__test/cleanup", "test"],
    ["/__test/seed", "test"],

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
    it("protects the conditionally mounted test router explicitly", () => {
      expect(resolvePolicy("/__test/cleanup")).toBe("test");
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
      // The bespoke /api/auth/keys routes are gone; the plugin's
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

describe("deniesAppPasswords", () => {
  it("refuses the whole /api/auth/ prefix, at every depth", () => {
    // Deny-by-default: whatever a future Better Auth version nests under here
    // is covered without anyone remembering to add it.
    for (const path of [
      "/api/auth/change-password",
      "/api/auth/change-email",
      "/api/auth/admin/list-users",
      "/api/auth/admin/set-role",
      "/api/auth/api-key/create",
      "/api/auth/some/plugin/added/later",
    ]) {
      expect(deniesAppPasswords(path), path).toBe(true);
    }
  });

  it("refuses credential management", () => {
    expect(deniesAppPasswords("/api/app-passwords")).toBe(true);
    expect(deniesAppPasswords("/api/app-passwords/abc123")).toBe(true);
    expect(deniesAppPasswords("/api/credentials/opds")).toBe(true);
    expect(deniesAppPasswords("/api/credentials/kosync")).toBe(true);
  });

  it("leaves the routes app passwords exist for alone", () => {
    // OPDS and KoSync are the reason the credential exists; /api/library and
    // friends are what Bruno, curl and cron drive with a Bearer token. If any
    // of these ever returns true, e-readers stop working.
    for (const path of [
      "/opds",
      "/opds/new",
      "/opds/download/abc",
      "/kosync/syncs/progress",
      "/api/library",
      "/api/books/abc",
      "/api/inbox",
      "/api/search",
      "/api/health",
    ]) {
      expect(deniesAppPasswords(path), path).toBe(false);
    }
  });

  it("does not let a deny prefix leak onto a sibling path", () => {
    // Same trap as the policy table's /api/auth/ rule: a prefix without the
    // trailing boundary would swallow neighbours that just start the same way.
    expect(deniesAppPasswords("/api/authors")).toBe(false);
    expect(deniesAppPasswords("/api/credential-report")).toBe(false);
  });

  it("says nothing about admin routes — the middleware decides those by policy", () => {
    // /api/jobs IS refused to app passwords, but via `policy === "admin"` in
    // authMiddleware, so a new admin route is scoped the moment it is added to
    // the policy table rather than needing a second edit here.
    expect(deniesAppPasswords("/api/jobs/status")).toBe(false);
    expect(resolvePolicy("/api/jobs/status")).toBe("admin");
  });
});
