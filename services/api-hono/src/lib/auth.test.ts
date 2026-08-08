import { describe, expect, it } from "vite-plus/test";
import type { Db } from "#db";
import { createMemorySecondaryStorage } from "../services/auth-secondary-storage.js";
import type { Env } from "../env.js";
import { createAuth, type CreateAuthDeps } from "./auth.js";

/**
 * These assertions pin the config to its deliberate choices. They are about
 * *options*, not behaviour: each one is a
 * choice that is cheap to flip by accident during an upgrade and expensive to
 * notice in production (a re-enabled cookie cache delays revocation, a lost
 * modelName silently points at the wrong table, and so on).
 */

const BASE_ENV = {
  NODE_ENV: "test",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  LIBRIS_COOKIE_SECURE: "0",
} as unknown as Env;

function build(overrides: Partial<CreateAuthDeps> = {}) {
  return createAuth({
    // The adapter resolves the schema lazily, on the first query, so building
    // the config never touches the database.
    db: {} as Db,
    secondaryStorage: createMemorySecondaryStorage(),
    env: BASE_ENV,
    secret: "test-only-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
    ...overrides,
  });
}

describe("createAuth", () => {
  it("maps the core models onto the project's plural table names", () => {
    const { options } = build();

    expect(options.user?.modelName).toBe("users");
    expect(options.session?.modelName).toBe("sessions");
    expect(options.account?.modelName).toBe("accounts");
    expect(options.verification?.modelName).toBe("verifications");
  });

  it("keeps sessions in the database and the cookie cache off", () => {
    const { options } = build();

    // Both halves matter: database-backed sessions are what make per-device
    // revocation listable, and the disabled cookie cache is what makes that
    // revocation take effect immediately instead of at cookie expiry.
    expect(options.session?.storeSessionInDatabase).toBe(true);
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  it("enables email+password without verification, since there is no SMTP transport", () => {
    const { options } = build();

    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
  });

  it("rate limits through secondary storage rather than memory or the database", () => {
    const { options } = build();

    expect(options.rateLimit?.storage).toBe("secondary-storage");
  });

  it("uses the explicit E2E switch rather than NODE_ENV to disable rate limiting", () => {
    expect(build({ env: { ...BASE_ENV, NODE_ENV: "production" } }).options.rateLimit?.enabled).toBe(
      true,
    );
    expect(build({ env: { ...BASE_ENV, NODE_ENV: "test" } }).options.rateLimit?.enabled).toBe(true);
    expect(
      build({ env: { ...BASE_ENV, NODE_ENV: "development", E2E_TEST: "1" } }).options.rateLimit
        ?.enabled,
    ).toBe(false);
  });

  it("uses the secondary storage instance it was given, opening no second connection", () => {
    const storage = createMemorySecondaryStorage();
    const { options } = build({ secondaryStorage: storage });

    expect(options.secondaryStorage).toBe(storage);
  });

  it("leaves id generation at the Better Auth default so ids stay text", () => {
    const { options } = build();

    // The cutover migration converts seven FK columns from uuid to text on the
    // strength of this. Setting generateId here would break that assumption.
    const advanced = options.advanced as { database?: { generateId?: unknown } } | undefined;
    expect(advanced?.database?.generateId).toBeUndefined();
  });

  describe("plugins", () => {
    it("registers exactly the admin and apiKey plugins", () => {
      const { options } = build();

      // The epic's hard non-goals include the organization, oidcProvider, SSO
      // and audit-log plugins. Asserting the exact set catches one being added
      // in passing as a dependency of something else.
      expect(options.plugins?.map((p) => p.id).sort()).toEqual(["admin", "api-key"]);
    });

    it("maps the apiKey plugin's model onto the apiKeys export", () => {
      const { options } = build();
      const plugin = options.plugins?.find((p) => p.id === "api-key");

      // The plugin's schema is what the Drizzle adapter resolves against, so
      // this is the assertion that catches a rename upstream. modelName is
      // present at runtime but absent from the published type.
      //
      // "apiKeys", not "api_keys": the adapter looks the model up as
      // schema[modelName], i.e. against the Drizzle EXPORT name. The SQL table
      // is api_keys, which comes from pgTable() in auth-schema.ts — getting
      // this wrong resolves to undefined and fails only on the first request
      // that touches an api key.
      const apikey = plugin?.schema?.apikey as { modelName?: string } | undefined;
      expect(apikey?.modelName).toBe("apiKeys");
    });

    // enableSessionForAPIKeys and storage:"database" cannot be asserted here —
    // the plugin object exposes only id/hooks/endpoints/schema, not the options
    // it was built with. They get behavioural coverage where they matter: an
    // API key resolving through getSession.
  });

  describe("trusted origins", () => {
    it("allows the Vite dev server origin outside production", () => {
      const { options } = build();

      // In dev the browser is on :3100 and reaches the API through Vite's
      // /api proxy, so that is the Origin header Better Auth sees.
      expect(options.trustedOrigins).toContain("http://localhost:3100");
    });

    it("trusts nothing extra in production, where the API serves the SPA itself", () => {
      const { options } = build({
        env: { ...BASE_ENV, NODE_ENV: "production" } as Env,
      });

      expect(options.trustedOrigins).toEqual([]);
      expect(options.advanced?.useSecureCookies).toBe(false);
    });

    it("controls secure cookies independently of NODE_ENV", () => {
      expect(
        build({ env: { ...BASE_ENV, NODE_ENV: "development", LIBRIS_COOKIE_SECURE: "1" } }).options
          .advanced?.useSecureCookies,
      ).toBe(true);
    });
  });

  describe("client ip resolution", () => {
    it("reads only the internally resolved client header", () => {
      const { options } = build();
      expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-libris-client-ip"]);
      expect(options.advanced?.ipAddress?.ipv6Subnet).toBe(64);
    });
  });

  it("keeps the session cookie host-only (no cross-subdomain cookies)", () => {
    const { options } = build();

    // COOKIE_DOMAIN was dropped in the security audit: a Domain
    // attribute is what lets a sibling subdomain shadow or fix the session
    // cookie. Host-only __Secure- denies that. The absence is structural now —
    // Better Auth's advanced config carries no crossSubDomainCookies key.
    expect("crossSubDomainCookies" in (options.advanced ?? {})).toBe(false);
  });
});
