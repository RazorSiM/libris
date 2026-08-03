import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../../app.js";
import { createTestDb, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { createAuth } from "../../lib/auth.js";
import { createMemorySecondaryStorage } from "../../services/auth-secondary-storage.js";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { eq } from "drizzle-orm";
import { withLastAdminLock } from "../../middleware/last-admin.js";

vi.mock("../../services/redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

vi.mock("../../services/queue.js", () => ({
  getQueues: () => ({ close: async () => {} }),
  getAllQueues: () => new Map(),
  registerQueue: () => {},
}));

vi.mock("../../services/event-bus.js", () => ({
  isEventBusHealthy: () => ({ ok: true }),
  initEventBus: () => {},
  getEventBus: () => ({ publish: () => {} }),
}));

/**
 * Better Auth mounted inside the real Hono app, so the whole middleware stack
 * runs. The point that needs proving is negative: authMiddleware is registered
 * on "*" ahead of every route, and it used to require an API key for anything
 * under /api/. If it does not stand aside for /api/auth/, Better Auth's own
 * endpoints answer 401 and no one can ever sign in.
 */

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  BETTER_AUTH_URL: "",
  COOKIE_DOMAIN: "",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  E2E_TEST: "",
  LOG_LEVEL: "info",
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
};

let pglite: PGlite;
let db: TestDb;

function createTestApp() {
  const auth = createAuth({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    secondaryStorage: createMemorySecondaryStorage(),
    env: TEST_ENV,
    secret: TEST_ENV.BETTER_AUTH_SECRET,
    baseURL: "http://localhost:3000",
  });

  // The auth instance is returned alongside the app: accounts are created
  // server-side through it now, since there is no HTTP sign-up.
  const { app } = createApp({
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
  return { app, auth };
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
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.verifications);
  await db.delete(schema.users);
  await db.delete(schema.appSettings);
});

async function createAdmin(
  auth: ReturnType<typeof createTestApp>["auth"],
  email: string,
): Promise<{ id: string; cookie: string }> {
  const created = await auth.api.createUser({
    body: {
      email,
      password: "correct-horse-battery",
      name: email.split("@")[0]!,
      role: "admin",
    },
  });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: "correct-horse-battery" },
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

async function setRoleOverHttp(
  app: ReturnType<typeof createTestApp>["app"],
  cookie: string,
  userId: string,
  role: "admin" | "user",
) {
  return await app.request("/api/auth/admin/set-role", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ userId, role }),
  });
}

async function adminActionOverHttp(
  app: ReturnType<typeof createTestApp>["app"],
  cookie: string,
  path: "ban-user" | "remove-user",
  userId: string,
) {
  return await app.request(`/api/auth/admin/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ userId }),
  });
}

describe("GET /api/auth/ok", () => {
  it("answers without any credentials", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/auth/ok");

    // Specifically not 401: that would mean authMiddleware intercepted it.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("the auth middleware stands aside for /api/auth/", () => {
  it("reaches Better Auth rather than being 401'd by the middleware", async () => {
    const { app } = createTestApp();

    // sign-up is disabled outright (disableSignUp), so the interesting thing is
    // WHICH refusal comes back: 400 from Better Auth means the request reached
    // it, where 401 would mean the middleware blocked the prefix.
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reader@example.com",
        password: "correct-horse-battery",
        name: "Reader",
      }),
    });

    expect(res.status).toBe(400);
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it("reaches nested plugin endpoints, not just the first path segment", async () => {
    const { app, auth } = createTestApp();

    // The admin plugin nests its routes under /api/auth/admin/*. Asserting on
    // the status alone cannot distinguish "middleware blocked it" from "Better
    // Auth refused an anonymous caller" — both are 401 — so this signs in as a
    // real admin and expects the endpoint to actually answer.
    // createUser, not sign-up: self-registration is disabled, and the admin
    // plugin permits a bare server-side call. It also sets the role directly,
    // which matters — a session carries a snapshot of the user from
    // secondaryStorage, so promoting afterwards would be invisible to it.
    await auth.api.createUser({
      body: {
        email: "boss@example.com",
        password: "correct-horse-battery",
        name: "Boss",
        role: "admin",
      },
    });

    const signedIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "boss@example.com", password: "correct-horse-battery" }),
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";

    const res = await app.request("/api/auth/admin/list-users?limit=10", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ users: [{ email: "boss@example.com" }] });
  });

  it("still protects the rest of /api/", async () => {
    const { app } = createTestApp();

    // The skip rule must not have punched a hole in the default policy.
    const res = await app.request("/api/books");

    expect(res.status).toBe(401);
  });

  it("does not skip auth for sibling paths that merely start with /api/auth", async () => {
    const { app } = createTestApp();

    const res = await app.request("/api/authors");

    expect(res.status).toBe(401);
  });
});

describe("last-admin invariant", () => {
  it("refuses a direct HTTP attempt to demote the sole admin", async () => {
    const { app, auth } = createTestApp();
    const admin = await createAdmin(auth, "sole-admin@example.com");

    const response = await setRoleOverHttp(app, admin.cookie, admin.id, "user");

    expect(response.status).toBe(409);
    const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
    expect(stored?.role).toBe("admin");
  });

  it("still allows demotion while another admin remains", async () => {
    const { app, auth } = createTestApp();
    const acting = await createAdmin(auth, "acting-admin@example.com");
    const target = await createAdmin(auth, "target-admin@example.com");

    const response = await setRoleOverHttp(app, acting.cookie, target.id, "user");

    expect(response.status).toBe(200);
    const admins = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
    expect(admins.map(({ id }) => id)).toEqual([acting.id]);
  });

  it.each(["ban-user", "remove-user"] as const)(
    "refuses to %s when the target is the sole admin",
    async (path) => {
      const { app, auth } = createTestApp();
      const admin = await createAdmin(auth, `${path}@example.com`);

      const response = await adminActionOverHttp(app, admin.cookie, path, admin.id);

      expect(response.status).toBe(409);
      const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
      expect(stored).toMatchObject({ role: "admin", banned: false });
    },
  );

  it("allows only one of two concurrent demotions", async () => {
    const { auth } = createTestApp();
    const first = await createAdmin(auth, "first-admin@example.com");
    const second = await createAdmin(auth, "second-admin@example.com");

    const attempts = await Promise.allSettled([
      withLastAdminLock(db as never, second.id, async (tx) => {
        await tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, second.id));
      }),
      withLastAdminLock(db as never, first.id, async (tx) => {
        await tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, first.id));
      }),
    ]);

    expect(attempts.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({ reason: { status: 409 } });
    const admins = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
    expect(admins).toHaveLength(1);
  });
});

describe("sign-in over HTTP", () => {
  /** Accounts are admin-created; there is no HTTP sign-up to drive. */
  async function createAccount(auth: ReturnType<typeof createTestApp>["auth"]) {
    return await auth.api.createUser({
      body: {
        email: "reader@example.com",
        password: "correct-horse-battery",
        name: "Reader",
      },
    });
  }

  it("issues a session cookie that /api/auth/get-session accepts", async () => {
    const { app, auth } = createTestApp();
    await createAccount(auth);

    // The cookie has to come from a real sign-in over the mounted handler —
    // that is the path this suite exists to cover.
    const signedIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", password: "correct-horse-battery" }),
    });
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toBeTruthy();

    const res = await app.request("/api/auth/get-session", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "reader@example.com" } });
  });

  it("rejects a bad password through the mounted handler", async () => {
    const { app, auth } = createTestApp();
    await createAccount(auth);

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", password: "wrong" }),
    });

    expect(res.status).not.toBe(200);
  });
});
