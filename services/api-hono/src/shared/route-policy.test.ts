import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("says nothing about admin routes declared in the policy table", () => {
    // /api/jobs IS refused to app passwords, but via `policy === "admin"` in
    // authMiddleware, so an admin route added to the policy table is scoped the
    // moment it is added rather than needing a second edit here.
    expect(deniesAppPasswords("/api/jobs/status")).toBe(false);
    expect(resolvePolicy("/api/jobs/status")).toBe("admin");
  });

  it("refuses the settings surface, whose admin check lives in the handler", () => {
    // 59m.13. PATCH /api/settings calls requireAdmin() and
    // GET /api/settings/status returns filesystem paths and every failed job's
    // payload to admins. Neither is expressible in the path-only policy table,
    // because GET /api/settings is user-visible on the same prefix.
    expect(deniesAppPasswords("/api/settings")).toBe(true);
    expect(deniesAppPasswords("/api/settings/status")).toBe(true);
  });
});

// ── The class of bug, not the instance (59m.13) ──────────────────────

/**
 * Two ways a route can demand admin authority, and only one of them is visible
 * to the policy table.
 *
 * ROUTE_TABLE scopes app passwords for anything it marks "admin". A handler
 * that instead calls requireAdmin() or branches on isAdmin() is invisible to
 * it: the path resolves to plain "api-key", the middleware's refusal never
 * fires, and the app password resolves into a full admin session. That is
 * exactly how PATCH /api/settings and GET /api/settings/status stayed reachable
 * from a credential sitting in plaintext on an e-reader.
 *
 * So this walks the routers, finds every in-handler admin check, and insists
 * the path be declared somewhere. A new one fails here rather than shipping.
 */
describe("in-handler admin checks are declared in the policy", () => {
  const routesDir = fileURLToPath(new URL("../routes/", import.meta.url));

  /** requireAdmin(c) — an authorization gate. Never exempt. */
  const ADMIN_GATE = /\brequireAdmin\s*\(/;
  /** isAdmin(c) — sometimes a gate, sometimes a row filter. See below. */
  const ADMIN_PREDICATE = /\bisAdmin\s*\(\s*c\b/;

  /**
   * Files where isAdmin() only widens what the caller sees of their OWN
   * surface, rather than unlocking a privileged one. These routes are meant to
   * work from an app password — they are half the reason it exists — so
   * denying them would break e-readers and cron jobs.
   *
   * Adding a file here is a deliberate claim that its isAdmin() calls are row
   * scoping. requireAdmin() is never exempt, whatever is listed here.
   */
  const ISADMIN_ROW_SCOPING_ONLY: Record<string, string> = {
    "api/inbox.ts": "widens a WHERE clause from own rows to all rows",
    "api/library.ts": "the uploader filter on the library listing",
    "api/events.ts": "chooses which per-user topics the socket subscribes to",
  };

  function listSourceFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => entry.split(sep).join("/"));
  }

  /**
   * Where each router module is mounted, read out of routes/index.ts rather
   * than assumed from the directory layout — if the two ever disagree, an
   * assumed mapping would quietly check the wrong path.
   */
  function readMounts(): Map<string, string> {
    const source = readFileSync(join(routesDir, "index.ts"), "utf8");

    const moduleByIdent = new Map<string, string>();
    for (const [, idents, spec] of source.matchAll(
      /import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+)\.js"/g,
    )) {
      for (const ident of idents.split(",").map((value) => value.trim())) {
        if (ident) moduleByIdent.set(ident, `${spec}.ts`);
      }
    }

    const mounts = new Map<string, string>();
    for (const [, mount, ident] of source.matchAll(/\.route\(\s*"([^"]+)",\s*([A-Za-z0-9_]+)/g)) {
      const module = moduleByIdent.get(ident);
      if (module) mounts.set(module, mount);
    }
    return mounts;
  }

  const mounts = readMounts();

  it("knows where every router module is mounted", () => {
    // Guards the two tests below against passing vacuously: an unparsed module
    // is a module whose admin checks were never looked at.
    const unmapped = listSourceFiles(routesDir).filter(
      (file) => file !== "index.ts" && !mounts.has(file),
    );

    expect(unmapped).toEqual([]);
  });

  function stripComments(source: string): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
  }

  function isDeclared(mount: string): boolean {
    return resolvePolicy(mount) === "admin" || deniesAppPasswords(mount);
  }

  it("declares every path whose handler calls requireAdmin()", () => {
    // The strict half: requireAdmin() IS the authorization decision, so there
    // is no such thing as a benign use of it on an undeclared path.
    const undeclared = [...mounts]
      .filter(([file]) =>
        ADMIN_GATE.test(stripComments(readFileSync(join(routesDir, file), "utf8"))),
      )
      .filter(([, mount]) => !isDeclared(mount))
      .map(([file, mount]) => `${file} -> ${mount}`);

    expect(undeclared).toEqual([]);
  });

  it("declares every path whose handler branches on isAdmin(), or classifies it as row scoping", () => {
    const undeclared = [...mounts]
      .filter(([file]) =>
        ADMIN_PREDICATE.test(stripComments(readFileSync(join(routesDir, file), "utf8"))),
      )
      .filter(([file, mount]) => !isDeclared(mount) && !(file in ISADMIN_ROW_SCOPING_ONLY))
      .map(([file, mount]) => `${file} -> ${mount}`);

    expect(undeclared).toEqual([]);
  });

  it("does not carry a row-scoping exemption for a file that no longer needs one", () => {
    // A stale exemption is a hole waiting for the next edit to that file.
    const stale = Object.keys(ISADMIN_ROW_SCOPING_ONLY).filter((file) => {
      if (!mounts.has(file)) return true;
      return !ADMIN_PREDICATE.test(stripComments(readFileSync(join(routesDir, file), "utf8")));
    });

    expect(stale).toEqual([]);
  });

  it("still lets the routes app passwords exist for through", () => {
    // The exemptions above are load-bearing in the other direction: if inbox,
    // library or the OPDS surface ever started refusing app passwords, every
    // e-reader in the house would stop syncing.
    for (const path of ["/api/inbox", "/api/library", "/api/books", "/opds", "/kosync/syncs"]) {
      expect(deniesAppPasswords(path), path).toBe(false);
    }
  });
});
