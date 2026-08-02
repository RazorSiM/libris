import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
// `better-auth/minimal` rather than `better-auth`: it is the documented entry
// point when a database adapter is used, and it keeps Kysely (only needed for
// direct database connections) out of the bundle entirely. Verified absent from
// the bundle.
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins/admin";
import type { BetterAuthOptions } from "better-auth/types";
import type { Db } from "#db";
import type { Env } from "../env.js";
// Relative rather than the "#db/schema" subpath import: apps/web typechecks
// this file transitively through the RPC client's exported types, and a
// package-private subpath resolves against the IMPORTING package's
// package.json — which in web's case has no #db mapping.
import * as schema from "../db/schema.js";

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
   * Passed in rather than read from `env` so this config can be constructed and
   * type-checked without the env schema, which matters for tests that build an
   * auth instance directly.
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
 * re-run the schema generation after any bump and diff it.
 */
/**
 * Where an app password may arrive, in precedence order.
 *
 * Setting `customAPIKeyGetter` REPLACES the plugin's default lookup rather than
 * adding to it, so `x-api-key` has to be handled here too or it stops working.
 *
 * - `x-api-key` — the plugin's own convention.
 * - `Authorization: Bearer` — what Bruno, curl and cron already send
 *  . Every existing consumer of a Libris key uses this form.
 * - `Authorization: Basic` — all an OPDS reader can speak.
 *   KOReader, Moon+, Thorium and Panels have no other option. The PASSWORD
 *   component is the credential; the username is informational.
 *
 * Deliberately absent: the old `extractKey` also accepted the key as the Basic
 * USERNAME. That form is gone, because it makes one string a secret in one
 * position and a public identifier in the other.
 *
 * Anything unparseable returns null, which reads as "no credential presented"
 * and produces a 401 rather than a 500.
 *
 * Exported because authMiddleware needs the same answer this getter gives, to
 * decide whether the session it just resolved came from an app password or from
 * a browser cookie. Two independent parsers would be two things
 * to keep in agreement; the scoping check would silently stop firing the moment
 * they drifted.
 */
export function apiKeyFromHeaders(headers: Headers | undefined): string | null {
  if (!headers) return null;

  const direct = headers.get("x-api-key");
  if (direct) return direct;

  const authorization = headers.get("authorization");
  if (!authorization) return null;

  const separator = authorization.indexOf(" ");
  if (separator === -1) return null;
  const scheme = authorization.slice(0, separator).toLowerCase();
  const value = authorization.slice(separator + 1).trim();
  if (!value) return null;

  if (scheme === "bearer") return value;
  if (scheme !== "basic") return null;

  // Node does not throw on malformed base64, it just yields garbage — which
  // then fails to match any key, which is the answer we want anyway.
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return decoded.slice(colon + 1) || null;
}

export function createAuth({ db, secondaryStorage, env, secret, baseURL }: CreateAuthDeps) {
  const isProduction = env.NODE_ENV === "production";
  const trustProxyHeaders = env.TRUST_PROXY_HEADERS === "1";

  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),

    // Sessions and rate-limit counters go to Redis; session rows are still
    // written to Postgres so the "connected devices" page can
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
      // Libris is a household app with admin-created accounts. Leaving this off
      // would expose POST /api/auth/sign-up/email publicly through the handler
      // catch-all in app.ts, which is open self-registration — the one thing the
      // epic explicitly ruled out. It disables the endpoint outright, including
      // server-side auth.api.signUpEmail calls, so both account creation paths
      // go through the admin plugin's createUser instead: the first-run
      // bootstrap in routes/api/setup.ts, and admin user management.
      disableSignUp: true,
      // No SMTP transport yet, so there is nowhere to send a
      // verification or reset mail. Admins reset passwords on a user's behalf.
      requireEmailVerification: false,
    },

    // Better Auth owns rate limiting for /api/auth/* — the app's own
    // LIBRIS_RATELIMIT_AUTH_* vars are retired. Counters go to
    // the same Redis as sessions so they survive a restart and are shared if
    // this ever runs more than one process.
    rateLimit: {
      // Off under test. Better Auth applies a much stricter window to
      // /sign-in/email than to other endpoints, and an E2E run signs in several
      // times in quick succession during setup — the throttled attempt then
      // surfaces as a failed login, which reads as a broken auth flow rather
      // than as rate limiting doing its job.
      enabled: env.NODE_ENV !== "test" && env.E2E_TEST !== "1",
      storage: "secondary-storage",
    },

    // `advanced.database.generateId` is deliberately NOT set, leaving Better
    // Auth's default text ids in place. The cutover migration
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
        // "apiKeys", not "api_keys": the adapter looks the model up as
        // `schema[modelName]`, i.e. against the Drizzle EXPORT name. The SQL
        // table is still api_keys — that comes from pgTable() in auth-schema.ts.
        schema: { apikey: { modelName: "apiKeys" } },
        // Lets an app password resolve through the same getSession call as a
        // cookie session, which is what collapses the old five-branch policy
        // switch in middleware/auth.ts into one lookup.
        //
        // Upstream flags this as "not recommended for production" because a
        // leaked key then carries full session authority. Libris accepts that
        // for OPDS/e-reader clients, which genuinely need to act as the user —
        // but only for the routes those clients need.
        //
        // THE MITIGATION IS NOT HERE. It is APP_PASSWORD_DENIED plus the admin
        // policy in shared/route-policy.ts, enforced by authMiddleware before
        // the session is even resolved. Scoping in the
        // middleware rather than through this plugin's `permissions` was
        // deliberate: permissions are stamped onto each key at creation time,
        // so a key minted before a rule changed keeps the old authority, and
        // the rule itself is then spread across every row of api_keys instead
        // of sitting in one readable table. The middleware evaluates the
        // current rule on every request.
        //
        // Turning this off is not a safe simplification either: it does not
        // narrow the key, it stops OPDS and Bearer clients authenticating at
        // all and brings back the five-branch switch.
        enableSessionForAPIKeys: true,
        // One configuration rather than a separate `opds` configId: the same
        // app password should work in a reader, in Bruno and in curl. Splitting
        // by configId would mean a user who follows an OPDS acquisition link
        // into /api/... suddenly needs a second credential.
        customAPIKeyGetter: (ctx) =>
          apiKeyFromHeaders(ctx.headers ?? ctx.request?.headers ?? undefined),
        // The plugin's default is 10 requests per DAY per key, which is not a
        // usable budget for the thing this credential exists to serve: opening
        // an OPDS catalog costs a handful of requests before the reader has
        // shown anything, and a library sync costs far more. Left at the
        // default, every e-reader stops working partway through its first
        // browse and reports it as an authentication failure.
        //
        // 600/minute matches the app's own general rate limit, so there is one
        // number to reason about rather than two interacting ones.
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: 600,
        },
        // Keys live in Postgres, not Redis: they are long-lived credentials a
        // user manages from the devices page, and losing them to a Redis flush
        // would silently unpair every e-reader.
        storage: "database",
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
