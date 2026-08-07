/**
 * Admin "remove user" against a target who owns books.
 *
 * `books.created_by` is NOT NULL ON DELETE RESTRICT, and Better Auth's
 * `internalAdapter.deleteUser` issues three UN-TRANSACTED statements: delete
 * sessions, delete accounts, delete user. Without a precondition the third hits
 * the constraint after the first two have committed — a 500, a surviving user
 * row with no credential, and no way for the admin to tell. libris-59m.21.
 */
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../app.js";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { AppVariables } from "../context.js";
import type { Env } from "../env.js";
import { createAuth } from "./auth.js";
import { reassignBooksOnRemoveUser } from "./user-deletion.js";
import { createMemorySecondaryStorage } from "../services/auth-secondary-storage.js";
import { createMemoryKVStore } from "../services/kv-store.js";

vi.mock("../services/redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

vi.mock("../services/queue.js", () => ({
  getQueues: () => ({ close: async () => {} }),
  getAllQueues: () => new Map(),
  registerQueue: () => {},
}));

vi.mock("../services/event-bus.js", () => ({
  isEventBusHealthy: () => ({ ok: true }),
  initEventBus: () => {},
  getEventBus: () => ({ publish: () => {} }),
}));

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  LIBRIS_COVER_FETCH_ALLOWLIST: [],
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  BETTER_AUTH_URL: "",
  LIBRIS_COOKIE_SECURE: "0",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  E2E_TEST: "",
  LOG_LEVEL: "info",
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
};

const PASSWORD = "correct-horse-battery";

let pglite: PGlite;
let db: TestDb;

/**
 * The real app, with the middleware registered exactly where app.ts registers
 * it: on POST /api/auth/admin/remove-user, ahead of Better Auth's catch-all.
 *
 * `withMiddleware: false` reproduces the pre-fix behaviour, which is what makes
 * the "old code half-deletes" assertions below able to fail.
 */
function createTestApp({ withMiddleware = true } = {}) {
  const auth = createAuth({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    secondaryStorage: createMemorySecondaryStorage(),
    env: TEST_ENV,
    secret: TEST_ENV.BETTER_AUTH_SECRET,
    baseURL: "http://localhost:3000",
  });

  const { app: inner } = createApp({
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      queues: {
        bookDetected: { add: async () => ({}) },
        bookParseFile: { add: async () => ({}) },
        bookFetchMetadata: { add: async () => ({}) },
        bookOrganize: { add: async () => ({}) },
        close: async () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      redisStorage: createMemoryKVStore(),
      cacheStorage: createMemoryKVStore(),
      auth,
      shutdown: async () => {},
    },
    env: TEST_ENV,
  });

  // The real app now registers reassignBooksOnRemoveUser itself (app.ts, on
  // POST /api/auth/admin/remove-user, ahead of Better Auth's catch-all), so the
  // fixed case IS createApp's output — nothing to wrap.
  if (withMiddleware) return { app: inner, auth };

  // The pre-fix wiring, rebuilt deliberately: context vars plus Better Auth's
  // catch-all and no precondition middleware. It cannot be produced by asking
  // createApp to leave the middleware out, because that is exactly what the fix
  // removed as an option — so reproducing the bug means bypassing createApp.
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("env", TEST_ENV);
    c.set("auth", auth);
    await next();
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  return { app, auth };
}

type TestApp = ReturnType<typeof createTestApp>["app"];
type TestAuth = ReturnType<typeof createTestApp>["auth"];

async function createUser(
  auth: TestAuth,
  email: string,
  role: "admin" | "user",
): Promise<{ id: string; cookie: string }> {
  const created = await auth.api.createUser({
    body: { email, password: PASSWORD, name: email.split("@")[0]!, role },
  });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return {
    id: created.user.id,
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}

function removeUser(app: TestApp, cookie: string, userId: string) {
  return app.request("/api/auth/admin/remove-user", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ userId }),
  });
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.bookFiles);
  await db.delete(schema.books);
  await db.delete(schema.apiKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
  await db.delete(schema.appSettings);
});

describe("POST /api/auth/admin/remove-user — target owns books", () => {
  it("succeeds and reassigns the books to the acting admin", async () => {
    const { app, auth } = createTestApp();
    const admin = await createUser(auth, "admin@example.test", "admin");
    const housemate = await createUser(auth, "housemate@example.test", "user");

    const [book] = await db
      .insert(schema.books)
      .values({ createdBy: housemate.id, title: "Dune" })
      .returning();

    const res = await removeUser(app, admin.cookie, housemate.id);
    // The assertion that fails against the old code: it was a 500.
    expect(res.status).toBe(200);

    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, housemate.id)),
    ).toHaveLength(0);

    // The library is shared; the books must not leave with the person.
    const [kept] = await db.select().from(schema.books).where(eq(schema.books.id, book.id));
    expect(kept.title).toBe("Dune");
    expect(kept.createdBy).toBe(admin.id);
  });

  it("does not touch books the acting admin already owned", async () => {
    const { app, auth } = createTestApp();
    const admin = await createUser(auth, "admin@example.test", "admin");
    const housemate = await createUser(auth, "housemate@example.test", "user");

    await db.insert(schema.books).values([
      { createdBy: admin.id, title: "Admin's own" },
      { createdBy: housemate.id, title: "Housemate's" },
    ]);

    expect((await removeUser(app, admin.cookie, housemate.id)).status).toBe(200);

    const owned = await db
      .select({ title: schema.books.title })
      .from(schema.books)
      .where(eq(schema.books.createdBy, admin.id));
    expect(owned.map((b) => b.title).sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
      "Admin's own",
      "Housemate's",
    ]);
  });

  it("half-deletes the account without the middleware, which is the bug", async () => {
    // Pins the mechanism rather than the symptom: Better Auth's deletion is
    // three un-transacted statements, so the accounts row is already gone by
    // the time the RESTRICT constraint rejects the user delete.
    const { app, auth } = createTestApp({ withMiddleware: false });
    const admin = await createUser(auth, "admin@example.test", "admin");
    const housemate = await createUser(auth, "housemate@example.test", "user");
    await db.insert(schema.books).values({ createdBy: housemate.id, title: "Dune" });

    const res = await removeUser(app, admin.cookie, housemate.id);
    expect(res.status).toBeGreaterThanOrEqual(500);

    // The user survives...
    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, housemate.id)),
    ).toHaveLength(1);
    // ...but their credential does not, so they can never sign in again.
    expect(
      await db.select().from(schema.accounts).where(eq(schema.accounts.userId, housemate.id)),
    ).toHaveLength(0);
  });

  it("leaves the account able to sign in when the removal is refused", async () => {
    // lastAdminMiddleware refuses removing the last active admin. The books
    // must go back, and the account must be untouched.
    //
    // Reaching a refusal through the real stack is not possible by design —
    // lastAdminMiddleware has already run, and once no book points at the
    // target the deletion has nothing left to fail on. So the downstream is
    // stubbed to refuse, which is what actually exercises the compensation.
    const { auth } = createTestApp();
    const admin = await createUser(auth, "admin@example.test", "admin");
    const housemate = await createUser(auth, "housemate@example.test", "user");

    const [theirs] = await db
      .insert(schema.books)
      .values({ createdBy: housemate.id, title: "Goes back" })
      .returning();
    const [adminsOwn] = await db
      .insert(schema.books)
      .values({ createdBy: admin.id, title: "Admin's own" })
      .returning();

    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("env", TEST_ENV);
      c.set("auth", auth);
      await next();
    });
    app.use("/api/auth/admin/remove-user", reassignBooksOnRemoveUser);
    app.post("/api/auth/admin/remove-user", (c) => c.json({ message: "refused" }, 409));

    const res = await removeUser(app, admin.cookie, housemate.id);
    // Better Auth still owns the response; the middleware does not rewrite it.
    expect(res.status).toBe(409);

    // The reassignment is undone...
    const [returned] = await db.select().from(schema.books).where(eq(schema.books.id, theirs.id));
    expect(returned.createdBy).toBe(housemate.id);
    // ...and the admin's own book was never in scope.
    const [untouched] = await db
      .select()
      .from(schema.books)
      .where(eq(schema.books.id, adminsOwn.id));
    expect(untouched.createdBy).toBe(admin.id);

    // The account is fully intact: the target can still sign in.
    const signedIn = await auth.api.signInEmail({
      body: { email: "housemate@example.test", password: PASSWORD },
    });
    expect(signedIn.user.id).toBe(housemate.id);
  });
});

describe("POST /api/auth/admin/remove-user — target owns no books", () => {
  it("removes the row and invalidates their session and app passwords", async () => {
    const { app, auth } = createTestApp();
    const admin = await createUser(auth, "admin@example.test", "admin");
    const housemate = await createUser(auth, "housemate@example.test", "user");

    const appPassword = await auth.api.createApiKey({
      body: { userId: housemate.id, name: "Kobo" },
    });

    // Both credentials work beforehand, so their failure afterwards means
    // something.
    expect(
      (await app.request("/api/health", { headers: { cookie: housemate.cookie } })).status,
    ).toBe(200);
    expect(
      (await app.request("/api/library", { headers: { "x-api-key": appPassword.key } })).status,
    ).toBe(200);

    expect((await removeUser(app, admin.cookie, housemate.id)).status).toBe(200);

    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, housemate.id)),
    ).toHaveLength(0);

    // The session goes through Better Auth's own deleteUserSessions, which
    // clears secondary storage too — deleting session ROWS behind its back does
    // not (lib/auth.integration.test.ts, "secondaryStorage session survives").
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: housemate.cookie }),
    });
    expect(session).toBeNull();

    // App passwords cascade from users.id at the database level.
    expect(
      await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.referenceId, housemate.id)),
    ).toHaveLength(0);
    expect(
      (await app.request("/api/library", { headers: { "x-api-key": appPassword.key } })).status,
    ).toBe(401);
  });
});
