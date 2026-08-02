export type AuthPolicy = "public" | "optional" | "api-key" | "admin" | "opds" | "kosync" | "skip";

interface PathRule {
  pattern: string;
  match: "exact" | "prefix";
}

interface RouteRule extends PathRule {
  policy: AuthPolicy;
}

function matches(path: string, rule: PathRule): boolean {
  return rule.match === "exact" ? path === rule.pattern : path.startsWith(rule.pattern);
}

/**
 * Declarative route → auth policy table.
 * First match wins; default is "api-key".
 */
const ROUTE_TABLE: RouteRule[] = [
  // Better Auth owns this whole prefix and authenticates its own endpoints, so
  // this middleware must stand aside for all of it. It has to be a prefix, not
  // a set of exact paths: plugins nest their routes (/api/auth/admin/*,
  // /api/auth/api-key/*), and an exact list would silently 401 anything added
  // by a future plugin or Better Auth version.
  //
  // The trailing slash is deliberate — it keeps sibling routes such as
  // /api/authors from being swallowed by the rule.
  { pattern: "/api/auth/", match: "prefix", policy: "skip" },

  // First-run bootstrap. Public by design, and self-guarding: it 409s once
  // any user exists (routes/api/setup.ts).
  { pattern: "/api/setup", match: "exact", policy: "public" },

  // Optional auth (enriched response if authed)
  { pattern: "/api/health", match: "exact", policy: "optional" },

  // KoSync — header-based auth handled by middleware
  { pattern: "/kosync/", match: "prefix", policy: "kosync" },

  // OPDS — Basic auth with service credentials (covers catalog and downloads)
  { pattern: "/opds", match: "prefix", policy: "opds" },

  // Dev/test-only routes (must precede the `/_` catch-all)
  { pattern: "/__test/", match: "prefix", policy: "skip" },

  // Nitro internals (Scalar, OpenAPI JSON)
  { pattern: "/_", match: "prefix", policy: "skip" },

  // Admin-only route prefixes
  { pattern: "/api/jobs", match: "prefix", policy: "admin" },

  // All API routes require auth by default
  { pattern: "/api/", match: "prefix", policy: "api-key" },
];

export function resolvePolicy(path: string): AuthPolicy {
  for (const rule of ROUTE_TABLE) {
    if (matches(path, rule)) return rule.policy;
  }
  // Non-API paths (SPA static files, /_nuxt/*, favicon, etc.) skip auth
  return "skip";
}

/**
 * Paths an app password may never reach, whatever role its owner holds.
 *
 * `enableSessionForAPIKeys` (lib/auth.ts) makes an app password resolve into a
 * full session, which is what collapsed the old five-branch policy switch into
 * one getSession call. The cost is authority: without this table, a credential
 * pasted into a KOReader config — where it sits in plaintext, on a device that
 * leaves the house — carries everything its owner can do. For an admin that is
 * user management, password changes and the minting of further credentials.
 *
 * DENY-BY-DEFAULT, on purpose. `/api/auth/` is a prefix rather than a list of
 * the endpoints that happen to be dangerous today, for the same reason the
 * policy table above uses a prefix there: plugins nest their routes, and an
 * enumerated list would quietly stop covering whatever the next Better Auth
 * version adds. An app password has no business anywhere under that prefix —
 * everything it authenticates is a browser concern.
 *
 * Measured with the guard disabled, /api/auth/ endpoints already answer 401 to
 * an api-key session on their own, so that entry is defence in depth today.
 * The three that were genuinely reachable, and are the reason this exists:
 * /api/jobs as a full admin, /api/app-passwords, and /api/credentials.
 *
 * Admin routes are not listed here. They are refused by policy in the
 * middleware, so a route added to the admin section of ROUTE_TABLE is scoped
 * the moment it is added, without a second edit here.
 *
 * What this must NOT touch, because they are the entire reason app passwords
 * exist: /opds (catalogue and downloads), /kosync, and the ordinary
 * /api/library, /api/books, /api/search surface that Bruno, curl and cron use.
 */
const APP_PASSWORD_DENIED: PathRule[] = [
  // Account mutation (password change, email change), the admin plugin's
  // user-management endpoints, and the plugin route that mints API keys.
  { pattern: "/api/auth/", match: "prefix" },

  // A credential must not manage credentials: no minting a second app password
  // from the first, and no revoking the others (which is both a lockout and a
  // way to force a re-pair onto an attacker's key).
  { pattern: "/api/app-passwords", match: "prefix" },

  // Sets the KoSync password and the Hardcover token — same class of thing:
  // one credential rewriting another.
  { pattern: "/api/credentials", match: "prefix" },
];

/**
 * Whether this path refuses app-password credentials outright.
 *
 * Separate from resolvePolicy because it is a different question. The policy
 * says how much authority a path demands; this says which kinds of credential
 * are allowed to supply it, and the two cut across each other — /api/auth/ is
 * "skip" (Better Auth authenticates its own endpoints) yet is the most
 * sensitive surface in the app.
 */
export function deniesAppPasswords(path: string): boolean {
  return APP_PASSWORD_DENIED.some((rule) => matches(path, rule));
}
