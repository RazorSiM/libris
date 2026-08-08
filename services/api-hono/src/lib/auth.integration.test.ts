import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Db } from "#db";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { createMemorySecondaryStorage } from "../services/auth-secondary-storage.js";
import { createAuth, type Auth } from "./auth.js";
import { eventSocketRegistry } from "./event-socket-registry.js";

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

    // `not.toBe(200)` was satisfied by a 500 too (libris-59m.31), so it could
    // not tell "refused" from "crashed".
    expect(second.status).toBe(400);
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

  /**
   * libris-59m.5. The after-hook in createAuth() must not fire for a call that
   * failed authorization.
   *
   * Better Auth's dispatcher catches the endpoint's APIError, stores it as the
   * return value and runs after-hooks anyway, so the hook used to read `userId`
   * straight off the request body of a REJECTED call and delete that user's
   * sessions. No credential of any kind was needed.
   */
  it("does not touch the target's sessions when the caller has no credential", async () => {
    const target = await auth.api.createUser({
      body: { email: "victim@example.com", password: PASSWORD, name: "Victim" },
    });
    const victimCookie = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "victim@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    expect(await auth.api.getSession({ headers: new Headers({ cookie: victimCookie }) })).not.toBe(
      null,
    );

    const rejection = await auth.api
      .setUserPassword({
        body: { userId: target.user.id, newPassword: "attacker-chosen-password" },
      })
      .then(() => null)
      .catch((err: { statusCode?: number }) => err);

    expect(rejection).toMatchObject({ statusCode: 401 });
    // The session survives — this is the assertion that fails without the
    // isAPIError guard.
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: victimCookie }) }),
    ).not.toBeNull();
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
    // ...and the password really was not changed either.
    const stillWorks = await auth.api.signInEmail({
      body: { email: "victim@example.com", password: PASSWORD },
      asResponse: true,
    });
    expect(stillWorks.status).toBe(200);
  });

  it("does not touch the target's sessions when the caller is a plain user", async () => {
    const target = await auth.api.createUser({
      body: { email: "victim2@example.com", password: PASSWORD, name: "Victim" },
    });
    const victimCookie = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "victim2@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    const bystanderCookie = cookieFrom(await signUp("bystander@example.com"));

    const rejection = await auth.api
      .setUserPassword({
        body: { userId: target.user.id, newPassword: "attacker-chosen-password" },
        headers: new Headers({ cookie: bystanderCookie }),
      })
      .then(() => null)
      .catch((err: { statusCode?: number }) => err);

    expect(rejection).toMatchObject({ statusCode: 403 });
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: victimCookie }) }),
    ).not.toBeNull();
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

  /**
   * libris-jyp. Deleting a user must not leave their sessions live in Redis.
   *
   * `internalAdapter.deleteUser` (better-auth 1.6.25,
   * dist/db/internal-adapter.mjs) deletes session ROWS, account rows and the
   * user row, and touches secondary storage nowhere. `findSession` reads
   * secondary storage FIRST and returns what it finds without re-checking that
   * the user still exists — so the deleted account's session keeps resolving,
   * with its cached user object attached, for the rest of its TTL.
   *
   * This calls `deleteUser` directly on purpose. `/admin/remove-user` calls
   * `deleteUserSessions` on the line above it, which masks the defect
   * completely, so a test that went through the endpoint would be green either
   * way. The primitive is what every other caller reaches for — Better Auth's
   * own `/delete-user` calls the pair in the opposite order — and it is what an
   * upstream refactor would leave behind.
   */
  it("clears a deleted user's sessions from secondary storage", async () => {
    const first = cookieFrom(await signUp("deleted@example.com"));
    const second = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "deleted@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    const userId = (await auth.api.getSession({ headers: new Headers({ cookie: first }) }))!.user
      .id;

    // Both devices are live in secondary storage beforehand, so their absence
    // afterwards means something.
    expect(await secondaryStorage.get(tokenFrom(first))).toBeTruthy();
    expect(await secondaryStorage.get(tokenFrom(second))).toBeTruthy();

    await (await auth.$context).internalAdapter.deleteUser(userId);

    // THE ASSERTIONS THAT FAIL WITHOUT THE user.delete HOOK: every one of these
    // returned the deleted account's session.
    expect(await secondaryStorage.get(tokenFrom(first))).toBeNull();
    expect(await secondaryStorage.get(tokenFrom(second))).toBeNull();
    expect(await secondaryStorage.get(`active-sessions-${userId}`)).toBeNull();
    for (const cookie of [first, second]) {
      expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    }
  });

  it("leaves other users' sessions alone when one account is deleted", async () => {
    const doomed = cookieFrom(await signUp("doomed@example.com"));
    const bystander = cookieFrom(await signUp("survivor@example.com"));
    const doomedId = (await auth.api.getSession({ headers: new Headers({ cookie: doomed }) }))!.user
      .id;

    await (await auth.$context).internalAdapter.deleteUser(doomedId);

    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: bystander }) }),
    ).not.toBeNull();
  });

  it("returns null for a cookie that was never issued", async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: "better-auth.session_token=not-a-real-token" }),
    });

    expect(session).toBeNull();
  });
});

/**
 * libris-59m.6, part three: a ban must unpair the devices, not just close the
 * browser sessions.
 *
 * middleware/auth.ts refuses a banned user's app-password session on every
 * request, but the rows themselves have to go inactive too — otherwise an unban
 * silently re-authorizes whatever was paired at ban time, including the device
 * that may be the reason for the ban.
 */
describe("banning a user", () => {
  async function banAdmin(email: string): Promise<Headers> {
    await auth.api.createUser({
      body: { email, password: PASSWORD, name: "Admin", role: "admin" },
    });
    return new Headers({
      cookie: cookieFrom(
        await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true }),
      ),
    });
  }

  async function keysFor(userId: string) {
    return await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.referenceId, userId));
  }

  it("disables the banned user's app passwords, and only theirs", async () => {
    const headers = await banAdmin("ban-admin@example.com");
    const target = await auth.api.createUser({
      body: { email: "bannable@example.com", password: PASSWORD, name: "Bannable" },
    });
    const bystander = await auth.api.createUser({
      body: { email: "bystander2@example.com", password: PASSWORD, name: "Bystander" },
    });
    const key = await auth.api.createApiKey({ body: { userId: target.user.id, name: "Kobo" } });
    await auth.api.createApiKey({ body: { userId: bystander.user.id, name: "Kindle" } });

    // Paired and working before the ban.
    expect(
      await auth.api.getSession({ headers: new Headers({ "x-api-key": key.key }) }),
    ).not.toBeNull();

    await auth.api.banUser({ body: { userId: target.user.id }, headers });

    expect(await keysFor(target.user.id)).toMatchObject([{ enabled: false }]);
    // Kept, not deleted: the user can still see what was cut off.
    expect(await keysFor(target.user.id)).toHaveLength(1);
    expect(await keysFor(bystander.user.id)).toMatchObject([{ enabled: true }]);

    // And the plugin itself now refuses the key (KEY_DISABLED), independently
    // of the middleware's ban check.
    const afterBan = await auth.api
      .getSession({ headers: new Headers({ "x-api-key": key.key }) })
      .catch((err: { statusCode?: number }) => err);
    expect(afterBan).toMatchObject({ statusCode: 401 });
  });

  it("leaves app passwords alone when the ban itself is refused", async () => {
    // The 59m.5 trap again: after-hooks run for a rejected call too, so an
    // unauthenticated ban attempt must not disable anybody's devices.
    const target = await auth.api.createUser({
      body: { email: "not-banned@example.com", password: PASSWORD, name: "Safe" },
    });
    await auth.api.createApiKey({ body: { userId: target.user.id, name: "Kobo" } });

    const rejection = await auth.api
      .banUser({ body: { userId: target.user.id } })
      .then(() => null)
      .catch((err: { statusCode?: number }) => err);

    expect(rejection).toMatchObject({ statusCode: 401 });
    expect(await keysFor(target.user.id)).toMatchObject([{ enabled: true }]);
  });
});

/**
 * libris-e0p: a live /api/events WebSocket must not outlive the credential it
 * was upgraded with.
 *
 * A socket authenticates once, at upgrade, and then never asks again. Every
 * HTTP path re-checks per request — libris-59m.6 made a ban bind to cookies,
 * app passwords and KoSync alike — so a banned user's downloads stopped dead
 * while their event stream carried on.
 *
 * These drive the REAL revocation endpoints against a real database and assert
 * on what the registry did, which is the only way to know the wiring holds. The
 * hooks are database hooks (createAuth's `databaseHooks`), so what is being
 * pinned is that every one of these endpoints funnels through
 * `internalAdapter.deleteSession` / `updateUser` / `deleteUser` — not that
 * somebody remembered to list the endpoint.
 */
describe("closing event sockets when the credential behind them dies", () => {
  const openSockets: (() => void)[] = [];

  /** A stand-in for an upgraded WebSocket, recording why it was closed. */
  function fakeSocket(userId: string, sessionToken: string | null) {
    const closedFor: string[] = [];
    const unregister = eventSocketRegistry.register({
      userId,
      sessionToken,
      close: (reason) => {
        closedFor.push(reason);
      },
    });
    openSockets.push(unregister);
    return { closedFor, unregister };
  }

  beforeEach(() => {
    // The registry is a process-wide singleton; a socket left behind by a
    // failed assertion would be closed by the next test's revocation.
    while (openSockets.length > 0) openSockets.pop()!();
  });

  async function signedInAdmin(email: string): Promise<Headers> {
    await auth.api.createUser({
      body: { email, password: PASSWORD, name: "Admin", role: "admin" },
    });
    return new Headers({
      cookie: cookieFrom(
        await auth.api.signInEmail({ body: { email, password: PASSWORD }, asResponse: true }),
      ),
    });
  }

  it("closes the socket whose own session was revoked, and leaves the sibling open", async () => {
    // THE FAILING ASSERTION. Before the fix nothing closed either socket:
    // `closedFor` stayed empty for both, and the revoked device kept receiving
    // events for a principal whose next HTTP request would have been a 401.
    const staying = cookieFrom(await signUp("two-devices@example.com"));
    const going = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "two-devices@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    const userId = (await auth.api.getSession({ headers: new Headers({ cookie: staying }) }))!.user
      .id;
    const stayingSocket = fakeSocket(userId, tokenFrom(staying));
    const goingSocket = fakeSocket(userId, tokenFrom(going));

    await auth.api.revokeSession({
      body: { token: tokenFrom(going) },
      headers: new Headers({ cookie: staying }),
    });

    expect(goingSocket.closedFor).toEqual(["session revoked"]);
    // Per-session, not per-user: revoking one device must not sign the other
    // one's event stream out too.
    expect(stayingSocket.closedFor).toEqual([]);
  });

  it("closes the socket when the user signs out", async () => {
    const cookie = cookieFrom(await signUp("signing-out@example.com"));
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    const socket = fakeSocket(session!.user.id, session!.session.token);

    await auth.api.signOut({ headers: new Headers({ cookie }) });

    expect(socket.closedFor).toEqual(["session revoked"]);
  });

  it("closes the socket when an admin resets the password out from under it", async () => {
    const headers = await signedInAdmin("reset-admin@example.com");
    const target = await auth.api.createUser({
      body: { email: "reset-target@example.com", password: PASSWORD, name: "Target" },
    });
    const cookie = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "reset-target@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    const socket = fakeSocket(target.user.id, tokenFrom(cookie));

    await auth.api.setUserPassword({
      body: { userId: target.user.id, newPassword: "replacement-password" },
      headers,
    });

    expect(socket.closedFor).toEqual(["session revoked"]);
  });

  it("closes a banned user's sockets, app-password ones included", async () => {
    // libris-59m.6 is why this one is called out separately. A ban deletes the
    // session ROWS, which reaches a browser socket through the session hook —
    // but an app-password socket has no session row at all (the apiKey plugin
    // synthesises one per request), so nothing session-shaped can ever reach
    // it. The user-level hook on the ban write is what does.
    const headers = await signedInAdmin("ban-socket-admin@example.com");
    const target = await auth.api.createUser({
      body: { email: "ban-socket@example.com", password: PASSWORD, name: "Bannable" },
    });
    const bystander = await auth.api.createUser({
      body: { email: "ban-bystander@example.com", password: PASSWORD, name: "Bystander" },
    });
    const cookie = cookieFrom(
      await auth.api.signInEmail({
        body: { email: "ban-socket@example.com", password: PASSWORD },
        asResponse: true,
      }),
    );
    const browserSocket = fakeSocket(target.user.id, tokenFrom(cookie));
    const koboSocket = fakeSocket(target.user.id, null);
    const bystanderSocket = fakeSocket(bystander.user.id, null);

    await auth.api.banUser({ body: { userId: target.user.id }, headers });

    expect(koboSocket.closedFor).toEqual(["account banned"]);
    expect(browserSocket.closedFor.length).toBeGreaterThan(0);
    expect(bystanderSocket.closedFor).toEqual([]);
  });

  it("closes a banned user's sockets when the ban arrives through admin/update-user", async () => {
    // The libris-59m.12 lesson: /admin/update-user sets `banned` too, and an
    // enumeration of endpoints that only knew about /admin/ban-user would miss
    // it. Hooking the database write covers both without listing either.
    const headers = await signedInAdmin("update-ban-admin@example.com");
    const target = await auth.api.createUser({
      body: { email: "update-ban@example.com", password: PASSWORD, name: "Bannable" },
    });
    const koboSocket = fakeSocket(target.user.id, null);

    await auth.api.adminUpdateUser({
      body: { userId: target.user.id, data: { banned: true } },
      headers,
    });

    expect(koboSocket.closedFor).toEqual(["account banned"]);
  });

  it("closes every socket of a removed account", async () => {
    const headers = await signedInAdmin("remove-admin@example.com");
    const target = await auth.api.createUser({
      body: { email: "removed@example.com", password: PASSWORD, name: "Gone" },
    });
    const koboSocket = fakeSocket(target.user.id, null);

    await auth.api.removeUser({ body: { userId: target.user.id }, headers });

    expect(koboSocket.closedFor).toContain("account removed");
  });

  it("leaves the sockets alone when the revocation itself is refused", async () => {
    // The libris-59m.5 trap, restated for this hook: after-hooks run for a
    // REJECTED call too. Database hooks fire on the write rather than on the
    // request, so an unauthenticated ban attempt must not close anybody's
    // stream — which would otherwise be a credential-free denial of service
    // against every signed-in user's event feed.
    const target = await auth.api.createUser({
      body: { email: "unrevoked@example.com", password: PASSWORD, name: "Safe" },
    });
    const socket = fakeSocket(target.user.id, null);

    const rejection = await auth.api
      .banUser({ body: { userId: target.user.id } })
      .then(() => null)
      .catch((err: { statusCode?: number }) => err);

    expect(rejection).toMatchObject({ statusCode: 401 });
    expect(socket.closedFor).toEqual([]);
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

/**
 * The production configuration branch (libris-59m.1).
 *
 * Everything above runs with NODE_ENV=test, which takes the dev
 * `trustedOrigins` list. Production takes `trustedOrigins: []` and relies
 * entirely on the origin Better Auth derives from `baseURL` — and with no
 * baseURL it derives one from `request.url`, which @hono/node-server builds
 * from the socket. Behind a TLS-terminating proxy that is `http://host`, while
 * the browser sends `Origin: https://host`, and the mismatch is a 403.
 */
describe("production origin handling", () => {
  const PUBLIC_ORIGIN = "https://libris.example.test";
  /** What @hono/node-server sees: the container's own plain-http socket. */
  const SOCKET_URL = "http://libris.example.test/api/auth/sign-in/email";

  const PROD_ENV = {
    NODE_ENV: "production",
    // Rate limiting is orthogonal to origin checking, and leaving it on would
    // let a 429 satisfy a "not 403" assertion.
    E2E_TEST: "1",
    TRUST_PROXY_HEADERS: "0",
    LIBRIS_TRUSTED_PROXIES: [],
    LIBRIS_COOKIE_SECURE: "1",
  } as unknown as Env;

  function productionAuth(baseURL: string | undefined): Auth {
    return createAuth({
      db: db as unknown as Db,
      secondaryStorage: createMemorySecondaryStorage(),
      env: PROD_ENV,
      secret: "test-only-secret-at-least-32-characters-long",
      baseURL,
    });
  }

  /**
   * A sign-in exactly as a browser sends it: https Origin, a cookie already in
   * the jar, and a request URL the node adapter built from the plain-http
   * socket.
   *
   * The cookie is load-bearing, not decoration. `validateOrigin` returns early
   * unless the request carries one (`origin-check.mjs`: `if (!(forceValidate ||
   * useCookies)) return`), so a cookie-less POST never reaches the trusted-origin
   * comparison at all. Any browser that has visited the app once has a cookie,
   * and every authenticated call — sign-out, revoke-session, mint an app
   * password — carries the session cookie by definition.
   */
  function browserSignIn(instance: Auth, email: string): Promise<Response> {
    return instance.handler(
      new Request(SOCKET_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "libris.example.test",
          origin: PUBLIC_ORIGIN,
          cookie: "libris.theme=dark",
        },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
  }

  it("signs a browser in over https when BETTER_AUTH_URL names the public origin", async () => {
    const instance = productionAuth(PUBLIC_ORIGIN);
    await instance.api.createUser({
      body: { email: "proxied@example.com", password: PASSWORD, name: "Proxied" },
    });

    const res = await browserSignIn(instance, "proxied@example.com");

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });

  it("refuses the same sign-in when no base URL is configured", async () => {
    // The defect itself, pinned. env.ts now refuses to boot a production
    // process without BETTER_AUTH_URL precisely so this configuration cannot
    // be reached; if a Better Auth upgrade ever makes this pass, the boot-time
    // requirement can be revisited on purpose rather than by accident.
    const instance = productionAuth(undefined);
    await instance.api.createUser({
      body: { email: "unproxied@example.com", password: PASSWORD, name: "Unproxied" },
    });

    const res = await browserSignIn(instance, "unproxied@example.com");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "INVALID_ORIGIN" });
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

    expect(res.status).toBe(401);
    // The property that matters is not the status code but that no session was
    // issued. `not.toBe(200)` asserted neither.
    expect(cookieFrom(res)).toBeFalsy();
  });

  it("rejects an unknown email", async () => {
    const res = await auth.api.signInEmail({
      body: { email: "nobody@example.com", password: "correct-horse-battery" },
      asResponse: true,
    });

    // Same status and no cookie as the wrong-password case above: a different
    // answer here would tell an attacker which addresses have accounts.
    expect(res.status).toBe(401);
    expect(cookieFrom(res)).toBeFalsy();
  });
});
