import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Db } from "#db";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { createMemorySecondaryStorage } from "../services/auth-secondary-storage.js";
import { createAuth, type Auth } from "./auth.js";

/**
 * Drives Better Auth against a real (PGlite) database with the project's own
 * migrations applied. Where auth.test.ts asserts the *config*, this asserts the
 * schema actually works: every mapping in createAuth() — plural table names,
 * camelCase keys resolving to snake_case columns, text ids — only fails on the
 * code path that touches it, so nothing short of real queries proves it.
 */

const TEST_ENV = {
  NODE_ENV: "test",
  E2E_TEST: "1",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  COOKIE_DOMAIN: "",
  LIBRIS_COOKIE_SECURE: "0",
} as unknown as Env;

let pglite: PGlite;
let db: TestDb;
let auth: Auth;
let secondaryStorage: ReturnType<typeof createMemorySecondaryStorage>;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  secondaryStorage = createMemorySecondaryStorage();

  auth = createAuth({
    // PGlite-backed drizzle rather than postgres-js. Same query builder, and
    // the adapter only ever sees the drizzle instance.
    db: db as unknown as Db,
    secondaryStorage,
    env: TEST_ENV,
    secret: "test-only-secret-at-least-32-characters-long",
    baseURL: "http://localhost:3000",
  });
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.verifications);
  await db.delete(schema.users);
});

const PASSWORD = "correct-horse-battery";

/**
 * Create an account and sign in, returning the sign-in response.
 *
 * Two calls rather than one because self-registration is disabled
 * (emailAndPassword.disableSignUp), which turns off auth.api.signUpEmail
 * everywhere including server-side. Accounts come from the admin plugin's
 * createUser, which permits a bare server-side call; the session then comes
 * from a normal sign-in, so these tests still exercise the real cookie path.
 */
async function signUp(email: string, password = PASSWORD) {
  await auth.api.createUser({ body: { email, password, name: "Test Person" } });
  return await auth.api.signInEmail({ body: { email, password }, asResponse: true });
}

function cookieFrom(res: Response): string {
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/** The store key for a session cookie: the token, without its signature. */
function tokenFrom(cookie: string): string {
  return decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0]!;
}

/**
 * Age a session by rewriting its createdAt in the secondary store.
 *
 * Freshness is measured from createdAt, and there is no way to reach a
 * day-old session in a test that finishes in milliseconds. Rewriting the
 * stored record is the same thing the clock would have done.
 */
async function ageSession(cookie: string, byDays: number): Promise<void> {
  const key = tokenFrom(cookie);
  const raw = await secondaryStorage.get(key);
  if (!raw) throw new Error("no stored session for that cookie");
  const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
  parsed.session.createdAt = new Date(Date.now() - byDays * 24 * 60 * 60 * 1000).toISOString();
  await secondaryStorage.set(key, JSON.stringify(parsed));
}

describe("better auth schema", () => {
  it("creates the four core tables with snake_case columns", async () => {
    const tables = await pglite.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = tables.rows.map((r) => r.tablename);

    expect(names).toContain("users");
    expect(names).toContain("sessions");
    expect(names).toContain("accounts");
    expect(names).toContain("verifications");
  });

  it("gives users a text id, not a uuid", async () => {
    // The cutover migration converts seven FK columns to text on this basis.
    const cols = await pglite.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = 'id'`,
    );

    expect(cols.rows[0]?.data_type).toBe("text");
  });

  it("indexes the columns that every auth request looks up", async () => {
    // users.email on every sign-in, sessions.token on every authenticated
    // request. Without these, auth degrades into a sequential scan per call.
    const indexes = await pglite.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
       AND tablename IN ('users', 'sessions', 'accounts', 'verifications')`,
    );
    const defs = indexes.rows.map((r) => r.indexdef).join("\n");

    expect(defs).toMatch(/users.*\(email\)/);
    expect(defs).toMatch(/sessions.*\(token\)/);
  });
});

describe("account creation", () => {
  it("writes a user and a credential account row", async () => {
    const res = await signUp("reader@example.com");
    expect(res.status).toBe(200);

    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("reader@example.com");
    expect(users[0]?.name).toBe("Test Person");

    // The password hash lives on accounts, not users.
    const accounts = await db.select().from(schema.accounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("credential");
    expect(accounts[0]?.userId).toBe(users[0]?.id);
    expect(accounts[0]?.password).toBeTruthy();
    expect(accounts[0]?.password).not.toBe("correct-horse-battery");
  });

  it("defaults a new user to the non-admin role", async () => {
    await signUp("reader@example.com");

    const users = await db.select().from(schema.users);
    // Authorization moves to the admin plugin's roles; a fresh account must not
    // inherit admin the way the old is_admin-on-a-key model allowed.
    expect(users[0]?.role).toBe("user");
  });

  it("rejects a second account for the same email", async () => {
    await signUp("reader@example.com");
    const second = await auth.api
      .createUser({
        body: { email: "reader@example.com", password: PASSWORD, name: "Impostor" },
      })
      .then(() => ({ status: 200 }))
      .catch((err: { statusCode?: number }) => ({ status: err.statusCode ?? 500 }));

    expect(second.status).not.toBe(200);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("revokes all target browser sessions after an admin sets their password", async () => {
    const admin = await auth.api.createUser({
      body: {
        email: "admin@example.com",
        password: PASSWORD,
        name: "Admin",
        role: "admin",
      },
    });
    const adminSignIn = await auth.api.signInEmail({
      body: { email: admin.user.email, password: PASSWORD },
      asResponse: true,
    });
    const target = await auth.api.createUser({
      body: { email: "target@example.com", password: PASSWORD, name: "Target" },
    });
    const firstTargetSession = await auth.api.signInEmail({
      body: { email: target.user.email, password: PASSWORD },
      asResponse: true,
    });
    const secondTargetSession = await auth.api.signInEmail({
      body: { email: target.user.email, password: PASSWORD },
      asResponse: true,
    });
    const unrelatedSession = await signUp("unrelated@example.com");
    const appPassword = await auth.api.createApiKey({
      body: { userId: target.user.id, name: "Target reader" },
    });

    await auth.api.setUserPassword({
      body: { userId: target.user.id, newPassword: "replacement-password" },
      headers: new Headers({ cookie: cookieFrom(adminSignIn) }),
    });

    for (const response of [firstTargetSession, secondTargetSession]) {
      expect(
        await auth.api.getSession({ headers: new Headers({ cookie: cookieFrom(response) }) }),
      ).toBeNull();
    }
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: cookieFrom(unrelatedSession) }),
      }),
    ).not.toBeNull();
    expect(
      await auth.api.getSession({ headers: new Headers({ "x-api-key": appPassword.key }) }),
    ).toMatchObject({ user: { id: target.user.id } });
  });

  it("resolves a session cookie back to the user", async () => {
    const res = await signUp("reader@example.com");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieFrom(res) }),
    });

    expect(session?.user.email).toBe("reader@example.com");
  });

  it("persists the session to the database so devices can be listed", async () => {
    // storeSessionInDatabase: sessions also live in Redis, but the row is what
    // makes per-device listing and revocation possible.
    const res = await signUp("reader@example.com");
    const cookie = cookieFrom(res);

    const rows = await db.select().from(schema.sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).toBeTruthy();
    expect(rows[0]?.expiresAt).toBeInstanceOf(Date);

    // And it is the same session the cookie resolves to.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.session.token).toBe(rows[0]?.token);
  });

  it("stops honouring a session as soon as it is revoked", async () => {
    // This is what the disabled cookie cache buys: revocation takes effect on
    // the very next request rather than whenever the cookie happens to expire.
    const res = await signUp("reader@example.com");
    const cookie = cookieFrom(res);
    const before = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(before).not.toBeNull();

    await auth.api.revokeSession({
      body: { token: before!.session.token },
      headers: new Headers({ cookie }),
    });

    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(await db.select().from(schema.sessions)).toHaveLength(0);
  });

  it("keeps serving a session whose row was deleted behind Better Auth's back", async () => {
    // Pinning a sharp edge rather than endorsing it. With secondaryStorage
    // configured, getSession is served from Redis and never consults the table,
    // so DELETEing the row is NOT a revocation — the session stays valid until
    // its TTL lapses.
    //
    // The "connected devices" page must therefore revoke through
    // auth.api.revokeSession, which clears both stores. A hand-rolled
    // `db.delete(sessions)` would render a device as signed-out in the UI while
    // it kept working.
    const res = await signUp("reader@example.com");
    const cookie = cookieFrom(res);

    await db.delete(schema.sessions);

    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
  });

  it("returns null for a cookie that was never issued", async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: "better-auth.session_token=not-a-real-token" }),
    });

    expect(session).toBeNull();
  });
});

describe("listing your own devices", () => {
  it("lists every session the account has open", async () => {
    const first = cookieFrom(await signUp("reader@example.com"));
    await auth.api.signInEmail({ body: { email: "reader@example.com", password: PASSWORD } });

    const sessions = await auth.api.listSessions({ headers: new Headers({ cookie: first }) });

    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => typeof s.token === "string")).toBe(true);
  });

  it("still lists them on a session older than a day", async () => {
    // list-sessions is the one endpoint this app exposes that sits behind
    // freshSessionMiddleware, and its default window is 24 hours against a
    // session lifetime of seven days. With the default in place the devices
    // list 403s for six sevenths of a session's life, and the only way to see
    // it is to sign out and back in — which destroys the session you came to
    // look at. session.freshAge: 0 in createAuth() is what keeps this passing.
    const cookie = cookieFrom(await signUp("longtimer@example.com"));
    await ageSession(cookie, 3);

    const sessions = await auth.api.listSessions({ headers: new Headers({ cookie }) });

    expect(sessions).toHaveLength(1);
  });

  it("revokes one device without touching the others", async () => {
    const staying = cookieFrom(await signUp("reader@example.com"));
    const going = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "reader@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );

    await auth.api.revokeSession({
      body: { token: tokenFrom(going) },
      headers: new Headers({ cookie: staying }),
    });

    expect(await auth.api.getSession({ headers: new Headers({ cookie: going }) })).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: staying }) })).not.toBeNull();
  });

  it("refuses to revoke a session belonging to somebody else", async () => {
    // The endpoint takes a bare token, so without the ownership check any
    // signed-in user could sign out any other by guessing or replaying one.
    const mine = cookieFrom(await signUp("mine@example.com"));
    const theirs = cookieFrom(await signUp("theirs@example.com"));

    await auth.api.revokeSession({
      body: { token: tokenFrom(theirs) },
      headers: new Headers({ cookie: mine }),
    });

    expect(await auth.api.getSession({ headers: new Headers({ cookie: theirs }) })).not.toBeNull();
  });

  it("revoke-others leaves the caller signed in and clears the rest", async () => {
    const keeping = cookieFrom(await signUp("reader@example.com"));
    const other = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "reader@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );

    await auth.api.revokeOtherSessions({ headers: new Headers({ cookie: keeping }) });

    expect(await auth.api.getSession({ headers: new Headers({ cookie: keeping }) })).not.toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeNull();
  });
});

describe("sign-in", () => {
  it("accepts the correct password", async () => {
    await signUp("reader@example.com");

    const res = await auth.api.signInEmail({
      body: { email: "reader@example.com", password: "correct-horse-battery" },
      asResponse: true,
    });

    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await signUp("reader@example.com");

    const res = await auth.api.signInEmail({
      body: { email: "reader@example.com", password: "wrong-password" },
      asResponse: true,
    });

    expect(res.status).not.toBe(200);
  });

  it("rejects an unknown email", async () => {
    const res = await auth.api.signInEmail({
      body: { email: "nobody@example.com", password: "correct-horse-battery" },
      asResponse: true,
    });

    expect(res.status).not.toBe(200);
  });
});
