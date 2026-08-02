export type AuthPolicy = "public" | "optional" | "api-key" | "admin" | "opds" | "kosync" | "skip";

interface RouteRule {
  pattern: string;
  match: "exact" | "prefix";
  policy: AuthPolicy;
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
    if (rule.match === "exact" && path === rule.pattern) return rule.policy;
    if (rule.match === "prefix" && path.startsWith(rule.pattern)) return rule.policy;
  }
  // Non-API paths (SPA static files, /_nuxt/*, favicon, etc.) skip auth
  return "skip";
}
