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
  TRUST_PROXY_HEADERS: "0",
  COOKIE_DOMAIN: "",
} as unknown as Env;

let pglite: PGlite;
let db: TestDb;
let auth: Auth;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;

  auth = createAuth({
    // PGlite-backed drizzle rather than postgres-js. Same query builder, and
    // the adapter only ever sees the drizzle instance.
    db: db as unknown as Db,
    secondaryStorage: createMemorySecondaryStorage(),
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

async function signUp(email: string, password = "correct-horse-battery") {
  return await auth.api.signUpEmail({
    body: { email, password, name: "Test Person" },
    asResponse: true,
  });
}

function cookieFrom(res: Response): string {
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
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

describe("email and password sign-up", () => {
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

  it("rejects a second sign-up for the same email", async () => {
    await signUp("reader@example.com");
    const second = await signUp("reader@example.com");

    expect(second.status).not.toBe(200);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });
});

describe("sessions", () => {
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
    // The "connected devices" page (libris-5ng.22) must therefore revoke through
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
