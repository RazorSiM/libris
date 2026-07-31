import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
// `better-auth/minimal` rather than `better-auth`: it is the documented entry
// point when a database adapter is used, and it keeps Kysely (only needed for
// direct database connections) out of the bundle entirely. Verified absent from
// dist in libris-5ng.1.
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import type { BetterAuthOptions } from "better-auth/types";
import type { Db } from "#db";
import type { Env } from "../env.js";
import * as schema from "#db/schema";

type SecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

export interface CreateAuthDeps {
  db: Db;
  /**
   * Redis-backed in production, in-memory in dev/test — see
   * services/auth-secondary-storage.ts. Sessions and rate-limit counters live
   * here; it reuses the shared ioredis connection rather than opening its own.
   */
  secondaryStorage: SecondaryStorage;
  env: Env;
  /**
   * Passed in rather than read from `env` because BETTER_AUTH_SECRET and
   * BETTER_AUTH_URL are added to the env schema in libris-5ng.5, which also
   * mounts the handler. Keeping them as arguments lets this config be written
   * and type-checked independently of that slice.
   */
  secret: string;
  /**
   * Omit to let Better Auth derive the origin from the incoming request, which
   * is what production needs: the container listens on http behind a proxy that
   * terminates https, so a fixed value would produce wrong cookie and redirect
   * origins.
   */
  baseURL?: string | undefined;
}

/**
 * ⚠︎ SCHEMA MAPPING IS UPGRADE-FRAGILE — RE-VERIFY ON EVERY BETTER AUTH BUMP.
 *
 * The `modelName` entries below and the api_keys mapping in the apiKey plugin
 * rename Better Auth's default singular tables (`user`, `session`, `account`,
 * `verification`, `apikey`) onto this project's plural convention. Better Auth
 * resolves model fields against the *JavaScript property keys* of the Drizzle
 * schema, not against SQL column names — which is why there are no `fields`
 * overrides here. The generated Drizzle schema keeps camelCase keys mapped to
 * snake_case columns (`emailVerified: boolean("email_verified")`), matching
 * db/schema.ts, and the adapter matches on `emailVerified`.
 *
 * A Better Auth upgrade can add, rename or retype a field on any of these
 * models. When that happens the adapter fails loudly at runtime with
 * `The field "x" does not exist in the "y" Drizzle schema` rather than silently
 * reading the wrong column — but only on the code path that touches it, so
 * re-run the schema generation in libris-5ng.4 after any bump and diff it.
 */
export function createAuth({ db, secondaryStorage, env, secret, baseURL }: CreateAuthDeps) {
  const isProduction = env.NODE_ENV === "production";
  const trustProxyHeaders = env.TRUST_PROXY_HEADERS === "1";

  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),

    // Sessions and rate-limit counters go to Redis; session rows are still
    // written to Postgres so the "connected devices" page (libris-5ng.22) can
    // list and revoke them per-device.
    secondaryStorage,

    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      storeSessionInDatabase: true,
      // Deliberately off. A signed cookie cache would serve session data for
      // its lifetime without touching the store, which means a revoked session
      // or a banned user would keep working until it expired. Revocation being
      // instant is worth a Redis read per request.
      cookieCache: { enabled: false },
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },

    emailAndPassword: {
      enabled: true,
      // No SMTP transport yet (libris-2ld), so there is nowhere to send a
      // verification or reset mail. Admins reset passwords on a user's behalf.
      requireEmailVerification: false,
    },

    // Better Auth owns rate limiting for /api/auth/* — the app's own
    // LIBRIS_RATELIMIT_AUTH_* vars are retired in libris-5ng.25. Counters go to
    // the same Redis as sessions so they survive a restart and are shared if
    // this ever runs more than one process.
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
    },

    // `advanced.database.generateId` is deliberately NOT set, leaving Better
    // Auth's default text ids in place. The cutover migration (libris-5ng.7)
    // converts the seven FK columns from uuid to text to match.
    advanced: {
      useSecureCookies: isProduction,
      ipAddress: trustProxyHeaders
        ? // Same precedence as shared/request-ip.ts so rate limiting and
          // session records agree with the rest of the app on who the caller is.
          { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] }
        : // Without a trusted proxy in front, forwarded headers are attacker
          // controlled: honouring them would let one client rotate its apparent
          // IP and sidestep rate limiting entirely.
          {},
      ...(env.COOKIE_DOMAIN
        ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
        : {}),
    },

    // Production is same-origin: the API serves the built SPA from ./public.
    // In dev the browser runs on the Vite server (3100) and reaches the API
    // through its /api proxy, so the Origin header it sends is localhost:3100.
    trustedOrigins: isProduction ? [] : ["http://localhost:3100", "http://localhost:3000"],

    plugins: [
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      apiKey({
        schema: { apikey: { modelName: "api_keys" } },
        // Lets an app password resolve through the same getSession call as a
        // cookie session, which is what collapses the old five-branch policy
        // switch in middleware/auth.ts into one lookup (libris-5ng.8).
        //
        // Upstream flags this as "not recommended for production" because a
        // leaked key then carries full session authority. Libris accepts that
        // for OPDS/e-reader clients, which genuinely need to act as the user;
        // the mitigation is scoping enforced at the middleware layer, tracked
        // separately.
        enableSessionForAPIKeys: true,
        // Keys live in Postgres, not Redis: they are long-lived credentials a
        // user manages from the devices page, and losing them to a Redis flush
        // would silently unpair every e-reader.
        storage: "database",
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
