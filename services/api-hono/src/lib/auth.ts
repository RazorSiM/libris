import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
// `better-auth/minimal` rather than `better-auth`: it is the documented entry
// point when a database adapter is used, and it keeps Kysely (only needed for
// direct database connections) out of the bundle entirely. Verified absent from
// the bundle.
import { betterAuth } from "better-auth/minimal";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import type { BetterAuthOptions } from "better-auth/types";
import type { Db } from "#db";
import type { Env } from "../env.js";
// Relative rather than the "#db/schema" subpath import: apps/web typechecks
// this file transitively through the RPC client's exported types, and a
// package-private subpath resolves against the IMPORTING package's
// package.json — which in web's case has no #db mapping.
import * as schema from "../db/schema.js";
import { betterAuthClientIpHeader } from "../shared/request-ip.js";
import { clearUserSessions } from "../services/auth-secondary-storage.js";
import { isUserBanned, type BannableUser } from "../shared/user-ban.js";
import { eventSocketRegistry } from "./event-socket-registry.js";

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
   * The public origin users reach, e.g. `https://libris.example.com`.
   *
   * MUST be set in production. Omitting it makes Better Auth fall back to
   * `getOrigin(request.url)` — the container's plain-http socket origin — and
   * that single derived origin becomes the whole trusted-origin list, so every
   * browser request carrying `Origin: https://...` is refused with 403
   * INVALID_ORIGIN. env.ts enforces this at boot; only dev and
   * test may leave it undefined.
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

  return betterAuth({
    baseURL,
    secret,
    // The explicit `schema` is load-bearing, not decoration. The adapter reads
    // `config.schema || db._.fullSchema`, and since drizzle 1.0.0-rc dropped
    // relational-queries v1 the driver no longer carries `_.fullSchema` at all.
    // Drop this argument and Better Auth throws at construction:
    // "Drizzle adapter failed to initialize. Schema not found."
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
      // Freshness off, which affects exactly one endpoint this app exposes:
      // GET /list-sessions, behind freshSessionMiddleware. Its default window
      // is 24 hours against a session lifetime of seven days, so the devices
      // list would refuse for six sevenths of a session's life — and the only
      // cure available to a user is to sign out and back in, destroying the
      // session they opened the page to inspect.
      //
      // This costs nothing in revocation strength. revoke-session,
      // revoke-sessions and revoke-other-sessions all use
      // sensitiveSessionMiddleware, which re-reads the authoritative store but
      // never consults freshAge, and changing a password needs the current
      // password rather than a recent sign-in. What is left behind the check is
      // a read of your own device list by a caller who already holds a valid
      // session for that account.
      freshAge: 0,
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

    /**
     * Close live /api/events WebSockets when the credential behind them dies.
     *
     * A socket authenticates once, at upgrade, and then lives for as long as
     * the tab is open. Every HTTP path re-checks on each request; the socket
     * checked nothing, so a signed-out, banned or password-reset principal kept
     * receiving events.
     *
     * THESE ARE DATABASE HOOKS, NOT ENDPOINT HOOKS, and that is the whole
     * point. Enumerating revocation endpoints is how this bug happens: there
     * are eleven of them in the plugins this app installs alone (/sign-out,
     * /revoke-session, /revoke-sessions, /revoke-other-sessions,
     * /change-password with revokeOtherSessions, /delete-user,
     * /admin/ban-user, /admin/update-user with banned:true,
     * /admin/set-user-password, /admin/revoke-user-session,
     * /admin/revoke-user-sessions, /admin/remove-user), plus expiry cleanup
     * inside /get-session, and a Better Auth upgrade can add more. Every one of
     * them funnels through `internalAdapter.deleteSession` / `deleteSessions` /
     * `deleteUserSessions` / `updateUser` / `deleteUser`, and those funnel
     * through `deleteWithHooks` / `updateWithHooks` (db/with-hooks.mjs), which
     * is where these fire. One choke point instead of a list to keep current.
     *
     * It also sidesteps the after-hook trap below: a database hook fires on an
     * actual write, so it cannot run for a call that was refused.
     *
     * NOT SUFFICIENT ON ITS OWN, by construction — hooks are in-process, a
     * session that merely expires is never deleted, and an app-password socket
     * has no session row to delete. routes/api/events.ts re-validates every
     * open socket on a timer as the backstop; see
     * EVENT_SOCKET_REVALIDATE_INTERVAL_MS.
     */
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            eventSocketRegistry.closeForSession(session.token, "session revoked");
          },
        },
      },
      user: {
        update: {
          after: async (user) => {
            // The ban paths delete the session rows too, so the hook above
            // already reaches a browser socket. An app-password socket carries
            // no session row at all (the apiKey plugin synthesises one per
            // request), and a ban binds to the person on every other
            // credential path — this is what makes it bind here as well.
            //
            // The cast is the price of a hook typed against the BASE user
            // model: `banned`/`banExpires` are fields the admin plugin adds to
            // the schema, so they arrive on the row but not on the signature.
            if (isUserBanned(user as BannableUser)) {
              eventSocketRegistry.closeForUser(user.id, "account banned");
            }
          },
        },
        delete: {
          after: async (user) => {
            /**
             * Finish the job `internalAdapter.deleteUser` leaves half-done.
             *
             * It deletes session ROWS and never the matching secondary-storage
             * entries, and `findSession` reads secondary storage before
             * Postgres — so a deleted account's session can still resolve, with
             * its cached user object attached, until the TTL lapses.
             * `/admin/remove-user` happens to call `deleteUserSessions` first,
             * which hides this; nothing makes that ordering a property of
             * deletion rather than one caller's habit.
             *
             * A database hook rather than a call bolted onto the admin route,
             * for the same reason the rest of this block is: it fires on the
             * write, so every caller of `deleteUser` is covered — including
             * ones a Better Auth upgrade adds — and it cannot run for a request
             * that was refused. Idempotent, so the remove-user path pays one
             * missing-key read for it.
             */
            await clearUserSessions(secondaryStorage, user.id);
            eventSocketRegistry.closeForUser(user.id, "account removed");
          },
        },
      },
    },

    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        /**
         * ⚠︎ INSPECT THE OUTCOME BEFORE ACTING. THIS IS NOT OPTIONAL.
         *
         * The dispatcher does not skip after-hooks when the endpoint fails.
         * `dist/api/dispatch.mjs` wraps the endpoint call in a `.catch` that
         * turns an APIError into `{response, status}`, assigns it to
         * `ctx.context.returned`, and then runs `runAfterHooks`
         * unconditionally. The admin plugin's authorization gate is
         * `use: [adminMiddleware]` on the endpoint, so it runs *inside* that
         * try block — an unauthorized caller's 401 arrives here as a value, not
         * as a thrown error, and every line below would otherwise run for them.
         *
         * Without this guard, an anonymous
         * `POST /api/auth/admin/set-user-password` got its 401 and still
         * signed the named user out of every device. Looped over admin ids it
         * was a credential-free denial of service.
         *
         * Any future hook added here inherits the same trap.
         */
        if (isAPIError(ctx.context.returned)) return;

        const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
        if (typeof userId !== "string") return;

        if (ctx.path === "/admin/set-user-password") {
          // An admin-set password is the recovery path for a forgotten or
          // compromised credential. A captured browser session must not survive
          // that recovery. Better Auth's own adapter call clears both Redis and
          // the persisted session rows; deleting rows directly would leave the
          // Redis-backed sessions valid until expiry. App passwords deliberately
          // remain valid because they are separately managed device credentials.
          await ctx.context.internalAdapter.deleteUserSessions(userId);
          return;
        }

        if (ctx.path === "/admin/ban-user") {
          /**
           * Unpair the banned user's devices.
           *
           * The plugin's own ban only deletes sessions, and an app password is
           * not a session — it resolves into one on each request, so a banned
           * user's Kobo, KOReader and curl scripts kept working indefinitely.
           * middleware/auth.ts now refuses a banned user's app-password
           * session too, but leaving live rows behind would mean an unban
           * silently re-authorizes every device that was paired at ban time.
           *
           * DISABLED, NOT DELETED, and deliberately not re-enabled on unban:
           * the row stays visible on the devices page so the user can see what
           * was cut off and mint a replacement, and an unban never resurrects a
           * credential that may be the reason for the ban. The `enabled` column
           * is what the apiKey plugin checks (`KEY_DISABLED`), so a disabled
           * row cannot authenticate even if the ban check were removed.
           */
          await ctx.context.adapter.updateMany({
            // The plugin's model KEY, which the adapter maps to the configured
            // modelName ("apiKeys") and thence to the api_keys table.
            model: "apikey",
            where: [{ field: "referenceId", value: userId }],
            update: { enabled: false },
          });
        }
      }),
    },

    // Better Auth owns rate limiting for the whole /api/auth/* prefix and
    // middleware/rate-limit.ts stands aside for it, so the two budgets cannot
    // stack. Counters go to the same Redis as sessions, so they survive a
    // restart and are shared if this ever runs more than one process.
    rateLimit: {
      // Off only for the explicit E2E harness. Better Auth applies a much stricter window to
      // /sign-in/email than to other endpoints, and an E2E run signs in several
      // times in quick succession during setup — the throttled attempt then
      // surfaces as a failed login, which reads as a broken auth flow rather
      // than as rate limiting doing its job.
      enabled: env.E2E_TEST !== "1",
      storage: "secondary-storage",
    },

    // `advanced.database.generateId` is deliberately NOT set, leaving Better
    // Auth's default text ids in place. The cutover migration
    // converts the seven FK columns from uuid to text to match.
    advanced: {
      // Transport security is an explicit deployment choice. Keeping it tied
      // to NODE_ENV encouraged HTTP/LAN operators to select development mode,
      // which also changes unrelated test and logging behaviour.
      useSecureCookies: env.LIBRIS_COOKIE_SECURE === "1",
      // Explicit for the same reason useSecureCookies is: left unset, Better
      // Auth derives it from process.env.NODE_ENV — `disableOriginCheck:
      // options.advanced?.disableOriginCheck ?? isTest()` in
      // context/create-context.ts — and `isTest()` reads a NODE_ENV captured at
      // module load. The whole origin defence therefore switched itself off
      // under `NODE_ENV=test` and no unit test could ever exercise it, which
      // is how the broken production origin check shipped. Pinning it to false
      // means the suite runs the same check production runs.
      disableOriginCheck: false,
      // app.ts overwrites this private header with the address resolved from
      // the TCP peer and trusted-proxy CIDRs. Better Auth never reads raw
      // forwarded headers, so its session tracking and limiter cannot diverge.
      ipAddress: { ipAddressHeaders: [betterAuthClientIpHeader], ipv6Subnet: 64 },
      // No crossSubDomainCookies: the session cookie is host-only, which is what
      // keeps a sibling subdomain from shadowing or fixing it. COOKIE_DOMAIN was
      // dropped in the security audit for the same reason —
      // __Host- would be the stronger guarantee but Better Auth only emits
      // __Secure-, and a host-only __Secure- cookie already denies subdomains.
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
