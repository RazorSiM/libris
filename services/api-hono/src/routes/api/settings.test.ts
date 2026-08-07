import { createMemoryKVStore } from "../../services/kv-store.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";

// Mock Redis-dependent modules so admin health/queue checks don't need a real connection
vi.mock("../../services/redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

const registeredQueuesRef: { current: Map<string, unknown> } = { current: new Map() };

vi.mock("../../services/queue.js", () => ({
  getQueues: () => ({
    close: async () => {},
  }),
  getAllQueues: () => registeredQueuesRef.current,
  registerQueue: (q: { name: string }) => {
    registeredQueuesRef.current.set(q.name, q);
  },
}));

vi.mock("../../services/event-bus.js", () => ({
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

let pglite: PGlite;
let db: TestDb;

/**
 * One shared Better Auth instance for the suite.
 *
 * Sessions are the credential these tests need now (see seedSession), and a
 * session minted by one instance is not visible to another: secondaryStorage is
 * per-instance and in memory. The app and the fixtures have to share.
 */
let auth: ReturnType<typeof createTestAuth>;

const SESSION_PASSWORD = "correct-horse-battery";
let seq = 0;

/**
 * A signed-in browser session.
 *
 * These routes used to be driven with an app password. They cannot be any
 * more: PATCH /api/settings is admin-gated in its handler and
 * GET /api/settings/status hands admins the queue counts, every failed job's
 * payload and the server's filesystem paths, so the whole prefix now refuses
 * app-password credentials (59m.13, shared/route-policy.ts).
 */
async function seedSession(options: { label: string; isAdmin: boolean }) {
  seq += 1;
  const email = `settings-${seq}@example.test`;
  const created = await auth.api.createUser({
    body: {
      email,
      password: SESSION_PASSWORD,
      name: options.label,
      role: options.isAdmin ? "admin" : "user",
    },
  });
  const { headers } = await auth.api.signInEmail({
    body: { email, password: SESSION_PASSWORD },
    returnHeaders: true,
  });
  return {
    userId: created.user.id,
    cookie: headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}

async function seedApiKey(options: { label: string; isAdmin: boolean }) {
  // isAdmin is a role on the USER now, not a flag on the credential.
  return await seedAppPassword(auth, db, {
    name: options.label,
    role: options.isAdmin ? "admin" : "user",
  });
}

function createTestApp() {
  return createApp({
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      queues: {
        bookDetected: { add: async () => ({}) },
        bookParseFile: { add: async () => ({}) },
        bookFetchMetadata: { add: async () => ({}) },
        bookOrganize: { add: async () => ({}) },
        close: async () => {},
      },
      redisStorage: createMemoryKVStore(),
      cacheStorage: createMemoryKVStore(),
      auth,
      shutdown: async () => {},
    },
    env: TEST_ENV,
  });
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  auth = createTestAuth(db, TEST_ENV);
});

afterAll(async () => {
  await pglite.close();
});

type FakeQueue = {
  name: string;
  getJobCounts: (...statuses: string[]) => Promise<Record<string, number>>;
  getJobs: (statuses: string[]) => Promise<unknown[]>;
};

function makeFakeQueue(name: string, overrides?: Partial<FakeQueue>): FakeQueue {
  return {
    name,
    getJobCounts: async () => ({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    }),
    getJobs: async () => [],
    ...overrides,
  };
}

describe("GET /api/settings/status", () => {
  beforeEach(() => {
    registeredQueuesRef.current = new Map();
  });

  it("returns full diagnostics for admin users", async () => {
    const { cookie } = await seedSession({ label: "Admin", isAdmin: true });
    const { app } = createTestApp();

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // Admin gets all fields populated (not null)
    expect(body.health).not.toBeNull();
    expect(body.health.status).toBeDefined();
    expect(body.health.checks).toBeDefined();
    expect(body.queues).not.toBeNull();
    expect(body.failedJobs).not.toBeNull();
    expect(body.failedJobs.jobs).toBeDefined();
    expect(body.failedJobs.total).toBeDefined();
    expect(body.settings).not.toBeNull();
    expect(body.settings.libraryPath).toBeDefined();
    expect(body.credentials).toBeDefined();
    expect(body.credentials.opds).toBeDefined();
    expect(body.credentials.kosync).toBeDefined();
    expect(body.credentials.hardcover).toBeDefined();
  });

  it("surfaces counts and failed jobs from all registered queues, not just pipeline", async () => {
    const { cookie } = await seedSession({ label: "Admin", isAdmin: true });

    // Seed the registry with a pipeline queue plus scheduler/maintenance queues.
    const bookDetected = makeFakeQueue("book-detected", {
      getJobCounts: async () => ({
        waiting: 1,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      }),
    });
    const hardcoverSync = makeFakeQueue("hardcover-sync", {
      getJobs: async (statuses) => {
        if (!statuses.includes("failed")) return [];
        return [
          {
            id: "hc-1",
            name: "sync",
            data: {},
            failedReason: "hardcover timeout",
            finishedOn: 1000,
            processedOn: 900,
            timestamp: 100,
            attemptsMade: 3,
            opts: { attempts: 3 },
          },
        ];
      },
    });
    const dbMaintenance = makeFakeQueue("db-maintenance");

    for (const q of [bookDetected, hardcoverSync, dbMaintenance]) {
      registeredQueuesRef.current.set(q.name, q);
    }

    const { app } = createTestApp();

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // Queue counts include pipeline + scheduler + maintenance queues
    expect(Object.keys(body.queues).sort()).toEqual([
      "book-detected",
      "db-maintenance",
      "hardcover-sync",
    ]);

    // Failed jobs from a non-pipeline (scheduler) queue are surfaced
    expect(body.failedJobs.total).toBe(1);
    expect(body.failedJobs.jobs[0]).toMatchObject({
      id: "hc-1",
      queueName: "hardcover-sync",
      error: "hardcover timeout",
    });
  });

  it("returns only credentials for non-admin users", async () => {
    const { cookie } = await seedSession({ label: "Regular", isAdmin: false });
    const { app } = createTestApp();

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // Non-admin gets null for diagnostics
    expect(body.health).toBeNull();
    expect(body.queues).toBeNull();
    expect(body.failedJobs).toBeNull();
    expect(body.settings).toBeNull();

    // But still gets credentials
    expect(body.credentials).toBeDefined();
    expect(body.credentials.opds).toBeDefined();
    expect(body.credentials.opds.service).toBe("opds");
    expect(body.credentials.kosync).toBeDefined();
    expect(body.credentials.kosync.service).toBe("kosync");
    expect(body.credentials.hardcover).toBeDefined();
    expect(body.credentials.hardcover.service).toBe("hardcover");
  });

  it("reports a configured KoSync credential, which lives in its own table", async () => {
    // KoSync is keyed by user in kosync_credentials, while opds and hardcover
    // are rows in service_credentials keyed by (user, service). Reading KoSync
    // from the wrong one answers "not configured" no matter what the user has
    // saved, and the settings form then renders permanently blank.
    const { userId, cookie } = await seedSession({ label: "KoSync Owner", isAdmin: false });
    await db.insert(schema.kosyncCredentials).values({
      userId,
      username: "reader-on-the-kobo",
      secretHash: "sha256-of-the-wire-secret",
    });

    const { app } = createTestApp();
    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.credentials.kosync).toMatchObject({
      service: "kosync",
      configured: true,
      username: "reader-on-the-kobo",
    });

    // And the other two still come back under their own names — they are read
    // from a different table, so nothing here may be positional.
    expect(body.credentials.opds.service).toBe("opds");
    expect(body.credentials.hardcover.service).toBe("hardcover");
  });

  /**
   * libris-59m.18. The admin payload used to answer the KoSync question twice:
   * `credentials.kosync.configured`, read from kosync_credentials and correct,
   * and `settings.kosyncConfigured`, read from service_credentials — a table
   * the kosync migration emptied and no writer has touched since, so it was
   * pinned to false. SettingsKosync.vue bound to the second one, so the red
   * "KoSync is not configured" alert survived every save.
   *
   * Non-admins get `settings: null`, which is why the case above could never
   * catch this: only an admin sees the block that was wrong.
   */
  it("reports one KoSync state to an admin, with no second flag to contradict it", async () => {
    const admin = await seedSession({ label: "KoSync Admin", isAdmin: true });
    const { app } = createTestApp();

    // Save through the real route rather than seeding the table, so the test
    // covers the writer and the reader agreeing on where the row lives.
    const put = await app.request("/api/credentials/kosync", {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ username: "admin-on-the-kindle", password: "a-long-enough-secret" }),
    });
    expect(put.status).toBe(200);

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { cookie: admin.cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.settings).not.toBeNull();
    expect(body.credentials.kosync).toMatchObject({
      configured: true,
      username: "admin-on-the-kindle",
    });
    // The duplicate is gone, not merely repaired: a second field is a second
    // chance to desync.
    expect(body.settings).not.toHaveProperty("kosyncConfigured");
    expect(Object.keys(body.settings).sort()).toEqual([
      "hardcoverMetadataEnabled",
      "hardcoverSyncEnabled",
      "inboxPath",
      "libraryPath",
    ]);
  });
});

describe("GET /api/settings", () => {
  it("shows filesystem paths only to admins", async () => {
    const admin = await seedSession({ label: "Settings Admin", isAdmin: true });
    const member = await seedSession({ label: "Settings Member", isAdmin: false });
    const { app } = createTestApp();

    const adminResponse = await app.request("/api/settings", {
      headers: { cookie: admin.cookie },
    });
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      libraryPath: TEST_ENV.LIBRIS_LIBRARY_PATH,
      inboxPath: TEST_ENV.LIBRIS_INBOX_PATH,
    });

    const memberResponse = await app.request("/api/settings", {
      headers: { cookie: member.cookie },
    });
    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.json();
    expect(memberBody).not.toHaveProperty("libraryPath");
    expect(memberBody).not.toHaveProperty("inboxPath");
  });
});

// ── App passwords are not admin credentials (59m.13) ────────────────

/**
 * The settings prefix carries admin authority that ROUTE_TABLE could not see.
 *
 * PATCH / gates on requireAdmin() in the handler and both GETs widen for
 * admins — filesystem paths on /api/settings, and on /status the queue counts,
 * every failed job's arguments and live DB/Redis health. All three resolved to
 * policy "api-key", so `curl -u any:<app-password>` against a household install
 * returned the lot to whoever read the OPDS password off the e-reader.
 */
describe("app passwords on the settings surface", () => {
  it("refuses an ADMIN's app password on every settings route", async () => {
    const { rawKey } = await seedApiKey({ label: "Leaked Admin Key", isAdmin: true });
    const { app } = createTestApp();
    const headers = { Authorization: `Bearer ${rawKey}` };

    // 403, not 401: the credential is valid, the route just does not take it.
    expect((await app.request("/api/settings", { headers })).status).toBe(403);
    expect((await app.request("/api/settings/status", { headers })).status).toBe(403);
    expect(
      (
        await app.request("/api/settings", {
          method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ hardcoverSyncEnabled: false }),
        })
      ).status,
    ).toBe(403);
  });

  it("leaves the setting it tried to change untouched", async () => {
    const { rawKey } = await seedApiKey({ label: "Leaked Admin Key 2", isAdmin: true });
    const admin = await seedSession({ label: "Real Admin", isAdmin: true });
    const { app } = createTestApp();
    const read = async () =>
      (await (
        await app.request("/api/settings", { headers: { cookie: admin.cookie } })
      ).json()) as {
        hardcoverSyncEnabled: boolean;
      };

    const before = await read();

    await app.request("/api/settings", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hardcoverSyncEnabled: !before.hardcoverSyncEnabled }),
    });

    // A 403 that still wrote would be the worst of both worlds.
    expect((await read()).hardcoverSyncEnabled).toBe(before.hardcoverSyncEnabled);
  });
});
