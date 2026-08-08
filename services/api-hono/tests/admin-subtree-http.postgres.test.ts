/**
 * The `/api/auth/admin/*` subtree driven over HTTP through the real app, on a
 * database that can actually run the shipped code path.
 *
 * `lastAdminMiddleware` holds a `SELECT ... FOR UPDATE` on an app_settings row
 * for the whole of `next()`, so the invariant is still true when Better Auth
 * performs the write. That write does NOT go through the middleware's
 * transaction handle — Better Auth's drizzle adapter captured the pooled `Db`
 * at construction — so the shipped path needs TWO connections at once: one
 * parked on the open transaction, one for the write.
 *
 * PGlite cannot provide the second one. It is a single embedded backend behind
 * an exclusive mutex (`_runExclusiveTransaction` in @electric-sql/pglite): while
 * `client.transaction()` is open, every other `client.query()` waits for it to
 * finish, and the one that would finish it is inside `next()`. The request
 * deadlocks and the test times out.
 *
 * That is why middleware/last-admin.ts used to carry a `NODE_ENV === "test"`
 * branch which ran the guard in a transaction it closed BEFORE calling
 * `next()` — so under the ordinary PGlite harness the shipped code was not the
 * code under test. The branch is gone; this file is where the
 * coverage it enabled now lives, against a real PostgreSQL server through
 * `createDb`, the same pooled postgres-js factory production uses.
 *
 * Moved here wholesale:
 * - the "last-admin invariant" block from src/routes/api/auth-handler.test.ts
 * - the three remove-user cases from src/lib/user-deletion.test.ts that drive
 *   `createApp`; the two that build a bare Hono app without
 *   lastAdminMiddleware stayed behind, because nothing holds a transaction
 *   open there.
 */
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { admin as adminPlugin } from "better-auth/plugins";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { createAuth } from "../src/lib/auth.js";
import { createMemorySecondaryStorage } from "../src/services/auth-secondary-storage.js";
import { createMemoryKVStore } from "../src/services/kv-store.js";
import { betterAuthClientIpHeader } from "../src/shared/request-ip.js";
import {
  announceSkip,
  createScratchDatabase,
  isPostgresReachable,
  SERVICES_ARE_REQUIRED,
  TEST_POSTGRES_URL,
  type ScratchDatabase,
} from "./backing-services.js";

vi.mock("../src/services/redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

vi.mock("../src/services/queue.js", () => ({
  getQueues: () => ({ close: async () => {} }),
  getAllQueues: () => new Map(),
  registerQueue: () => {},
}));

vi.mock("../src/services/event-bus.js", () => ({
  isEventBusHealthy: () => ({ ok: true }),
  initEventBus: () => {},
  getEventBus: () => ({ publish: () => {} }),
}));

const PASSWORD = "correct-horse-battery";

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
  LIBRIS_RATELIMIT_AUTH_LIMIT: 600,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 600,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
};

const reachable = await isPostgresReachable();

if (!reachable) {
  const why =
    `PostgreSQL at ${TEST_POSTGRES_URL} is unreachable. The last-admin guard CANNOT be driven ` +
    `over HTTP on PGlite: the middleware holds a transaction open across Better Auth's write, ` +
    `and PGlite's single backend makes that a deadlock rather than a test. These tests check ` +
    `nothing unless a real server is there. Start one with ` +
    `\`docker compose -f docker-compose.test.yml up -d --wait postgres\`, or point ` +
    `LIBRIS_TEST_POSTGRES_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("admin-subtree-http.postgres.test.ts", why);
}

describe.skipIf(!reachable)("the admin subtree over HTTP, against real PostgreSQL", () => {
  let scratch: ScratchDatabase;
  let db: Db;

  beforeAll(async () => {
    scratch = await createScratchDatabase("adminhttp");
    db = scratch.db;
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  async function resetDatabase(): Promise<void> {
    await db.delete(schema.bookFiles);
    await db.delete(schema.books);
    await db.delete(schema.apiKeys);
    await db.delete(schema.sessions);
    await db.delete(schema.accounts);
    await db.delete(schema.verifications);
    await db.delete(schema.users);
    await db.delete(schema.appSettings);
  }

  interface TestAppOptions {
    /**
     * Called with the headers of every `auth.api.getSession` the request stack
     * makes. Used to assert what the middleware layer actually hands Better
     * Auth, which is not observable from the response.
     */
    onGetSession?: (headers: Headers) => void;
  }

  function createTestApp(options: TestAppOptions = {}) {
    const auth = createAuth({
      db,
      secondaryStorage: createMemorySecondaryStorage(),
      env: TEST_ENV,
      secret: TEST_ENV.BETTER_AUTH_SECRET,
      baseURL: "http://localhost:3000",
    });

    if (options.onGetSession) {
      const { onGetSession } = options;
      const original = auth.api.getSession;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (auth.api as any).getSession = (input: any) => {
        onGetSession(new Headers(input?.headers ?? {}));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return original(input);
      };
    }

    const { app } = createApp({
      services: {
        db,
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

  type TestApp = ReturnType<typeof createTestApp>["app"];
  type TestAuth = ReturnType<typeof createTestApp>["auth"];

  async function createUser(
    auth: TestAuth,
    email: string,
    role: "admin" | "user" = "admin",
  ): Promise<{ id: string; cookie: string }> {
    // createUser, not sign-up: self-registration is disabled outright, and the
    // admin plugin permits a bare server-side call. It also sets the role
    // directly, which matters — a session carries a snapshot of the user, so
    // promoting afterwards would be invisible to it.
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

  function postAdmin(app: TestApp, cookie: string, path: string, body: unknown) {
    return app.request(`/api/auth/admin/${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    });
  }

  const setRole = (app: TestApp, cookie: string, userId: string, role: "admin" | "user") =>
    postAdmin(app, cookie, "set-role", { userId, role });

  /**
   * /admin/update-user nests the privilege fields under `data`, which is the
   * whole defect: the guard read `body.role`, found undefined, and stood aside
   * while Better Auth wrote `data.role` to the database.
   */
  const updateUser = (app: TestApp, cookie: string, userId: string, data: object) =>
    postAdmin(app, cookie, "update-user", { userId, data });

  async function activeAdminIds(): Promise<string[]> {
    const rows = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
    return rows.map(({ id }) => id);
  }

  describe("last-admin invariant", () => {
    it("refuses a direct HTTP attempt to demote the sole admin", async () => {
      const { app, auth } = createTestApp();
      const admin = await createUser(auth, "sole-admin@example.com");

      const response = await setRole(app, admin.cookie, admin.id, "user");

      expect(response.status).toBe(409);
      const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
      expect(stored?.role).toBe("admin");
    });

    it("still allows demotion while another admin remains", async () => {
      // The case the removed NODE_ENV branch could never reach on PGlite: the
      // guard permits, so `next()` runs INSIDE the open transaction and Better
      // Auth writes on a second connection. On PGlite this deadlocked.
      const { app, auth } = createTestApp();
      const acting = await createUser(auth, "acting-admin@example.com");
      const target = await createUser(auth, "target-admin@example.com");

      const response = await setRole(app, acting.cookie, target.id, "user");

      expect(response.status).toBe(200);
      expect(await activeAdminIds()).toEqual([acting.id]);
    });

    it.each(["ban-user", "remove-user"] as const)(
      "refuses to %s when the target is the sole admin",
      async (path) => {
        const { app, auth } = createTestApp();
        const admin = await createUser(auth, `${path}@example.com`);

        const response = await postAdmin(app, admin.cookie, path, { userId: admin.id });

        expect(response.status).toBe(409);
        const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
        expect(stored).toMatchObject({ role: "admin", banned: false });
      },
    );

    /**
     * lib/auth.ts tells Better Auth to read the client address from one
     * private header, on the stated invariant that the app always
     * overwrites it with the address resolved from the TCP peer and the
     * trusted-proxy CIDRs. app.ts only does that inside the /api/auth/*
     * catch-all HANDLER, which runs AFTER this middleware — so passing
     * `c.req.raw.headers` straight through handed Better Auth whatever the
     * client sent.
     */
    it("never lets a client-supplied private IP header reach Better Auth", async () => {
      const seen: string[] = [];
      const { app, auth } = createTestApp({
        onGetSession: (headers) => seen.push(headers.get(betterAuthClientIpHeader) ?? "<absent>"),
      });
      const acting = await createUser(auth, "spoof-acting@example.com");
      const target = await createUser(auth, "spoof-target@example.com");
      seen.length = 0;

      const response = await app.request("/api/auth/admin/set-role", {
        method: "POST",
        headers: {
          cookie: acting.cookie,
          "content-type": "application/json",
          origin: "http://localhost:3000",
          [betterAuthClientIpHeader]: "203.0.113.9",
        },
        body: JSON.stringify({ userId: target.id, role: "user" }),
      });

      expect(response.status).toBe(200);
      // The middleware really did consult Better Auth — otherwise this asserts
      // nothing at all.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain("203.0.113.9");
      // getRequestIp falls back to the loopback identity when there is no socket.
      expect(new Set(seen)).toEqual(new Set(["127.0.0.1"]));
    });

    // ── /admin/update-user ─────────────────────────────────────────────
    //
    // The guard used to be three paths listed in app.ts, and update-user was
    // not one of them. It performs the same writes: `data.role` and the ban
    // fields. Against that code the first test below returned 200 and left the
    // install with zero admins — /api/jobs, PATCH /api/settings and create-user
    // all 403 for everyone, recoverable only by hand-editing the database.

    it("refuses to demote the sole admin through update-user's nested data.role", async () => {
      const { app, auth } = createTestApp();
      const admin = await createUser(auth, "nested-demotion@example.com");

      const response = await updateUser(app, admin.cookie, admin.id, { role: "user" });

      expect(response.status).toBe(409);
      const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
      expect(stored?.role).toBe("admin");
    });

    it("refuses to ban the sole admin through update-user's nested data.banned", async () => {
      const { app, auth } = createTestApp();
      const admin = await createUser(auth, "nested-ban@example.com");

      const response = await updateUser(app, admin.cookie, admin.id, { banned: true });

      // 409, not the 400 Better Auth's own YOU_CANNOT_BAN_YOURSELF produces.
      // The distinction is the point: that check only knows about self, while
      // the invariant is about the last admin, so it is our guard that answers.
      expect(response.status).toBe(409);
      const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
      expect(stored).toMatchObject({ role: "admin", banned: false });
    });

    it("still allows an ordinary profile edit on the sole admin", async () => {
      // The guard must not have become "the last admin is immutable".
      const { app, auth } = createTestApp();
      const admin = await createUser(auth, "renamed-admin@example.com");

      const response = await updateUser(app, admin.cookie, admin.id, { name: "Renamed" });

      expect(response.status).toBe(200);
      const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
      expect(stored).toMatchObject({ name: "Renamed", role: "admin" });
    });

    it("still allows demotion through update-user while another admin remains", async () => {
      const { app, auth } = createTestApp();
      const acting = await createUser(auth, "acting-updater@example.com");
      const target = await createUser(auth, "target-updatee@example.com");

      const response = await updateUser(app, acting.cookie, target.id, { role: "user" });

      expect(response.status).toBe(200);
      expect(await activeAdminIds()).toEqual([acting.id]);
    });

    // ── The whole admin surface, not the endpoints we happened to think of ──

    const adminPostEndpoints = Object.values(
      adminPlugin().endpoints as Record<string, { path: string; options?: { method?: string } }>,
    )
      .filter(({ options }) => options?.method === "POST")
      .map(({ path }) => path);

    it.each(adminPostEndpoints)(
      "leaves the sole admin an active admin after POST %s",
      async (pluginPath) => {
        // Sweeps every mutating endpoint the installed admin plugin exposes
        // with the most demotion-shaped body each of them could accept, in both
        // the flat and the nested shape. Whatever the endpoint answers — 409
        // from the guard, 400 from Better Auth's validation, 200 for the
        // harmless ones — the one thing that must hold is that the install
        // still has an admin.
        const { app, auth } = createTestApp();
        const admin = await createUser(auth, "sweep@example.com");

        await app.request(`/api/auth${pluginPath}`, {
          method: "POST",
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({ userId: admin.id, role: "user", data: { role: "user" } }),
        });

        const [stored] = await db.select().from(schema.users).where(eq(schema.users.id, admin.id));
        expect(stored, `${pluginPath} deleted the last admin`).toBeDefined();
        expect(stored, `${pluginPath} stripped the last admin`).toMatchObject({
          role: "admin",
          banned: false,
        });
      },
    );

    // The CONCURRENCY case deliberately does not live here. It
    // exercises `withLastAdminLock` directly, two calls at once, in
    // tests/last-admin-lock.postgres.test.ts — where it can assert that the
    // second transaction BLOCKS until the first commits. Driving that through
    // Hono's `app.request` would measure the whole stack instead of the lock.
  });

  describe("POST /api/auth/admin/remove-user", () => {
    /**
     * `books.created_by` is NOT NULL ON DELETE RESTRICT, and Better Auth's
     * `internalAdapter.deleteUser` issues three UN-TRANSACTED statements. Without
     * reassignBooksOnRemoveUser the third hits the constraint after the first two
     * have committed.
     *
     * These three cases moved out of src/lib/user-deletion.test.ts because they
     * drive `createApp`, which mounts lastAdminMiddleware ahead of the
     * reassignment — so the whole request now runs inside an open transaction and
     * needs a second connection. The two cases that build a bare Hono app,
     * including the "half-deletes without the middleware" mechanism pin, stayed
     * on PGlite.
     */
    const removeUser = (app: TestApp, cookie: string, userId: string) =>
      postAdmin(app, cookie, "remove-user", { userId });

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
      const [kept] = await db.select().from(schema.books).where(eq(schema.books.id, book!.id));
      expect(kept!.title).toBe("Dune");
      expect(kept!.createdBy).toBe(admin.id);
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

    /**
     * The same spoofable-client-address defect, in the copy nobody had looked
     * at.
     *
     * `reassignBooksOnRemoveUser` also resolves the acting session before
     * Better Auth's catch-all runs, and it was still passing
     * `c.req.raw.headers` — so on the one endpoint that has TWO middlewares
     * ahead of the handler, one of them had been fixed and the other had not.
     * The fix is structural: `sessionHeaders(c)` is now the only way to build
     * these headers, and request-ip.test.ts fails on a call site that does not
     * use it.
     */
    it("never lets a client-supplied private IP header reach Better Auth", async () => {
      const seen: string[] = [];
      const { app, auth } = createTestApp({
        onGetSession: (headers) => seen.push(headers.get(betterAuthClientIpHeader) ?? "<absent>"),
      });
      const admin = await createUser(auth, "spoof-remover@example.test", "admin");
      const housemate = await createUser(auth, "spoof-removed@example.test", "user");
      await db.insert(schema.books).values({ createdBy: housemate.id, title: "Dune" });
      seen.length = 0;

      const response = await app.request("/api/auth/admin/remove-user", {
        method: "POST",
        headers: {
          cookie: admin.cookie,
          "content-type": "application/json",
          origin: "http://localhost:3000",
          [betterAuthClientIpHeader]: "203.0.113.9",
        },
        body: JSON.stringify({ userId: housemate.id }),
      });

      expect(response.status).toBe(200);
      // Both middlewares consult Better Auth on this path; without this the
      // assertions below could pass by asserting nothing.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      // THE ASSERTION THAT FAILS AGAINST THE OLD CODE: reassignBooksOnRemoveUser
      // handed the spoofed value straight through.
      expect(seen).not.toContain("203.0.113.9");
      expect(new Set(seen)).toEqual(new Set(["127.0.0.1"]));
    });

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
      // clears secondary storage too — deleting session ROWS behind its back
      // does not (lib/auth.integration.test.ts).
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
});
