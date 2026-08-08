/**
 * Owner-scoping of the pre-approval (inbox/review) surfaces the dashboard and
 * the command palette expose.
 *
 * The organized library is shared — every user sees every organized book, and
 * `recentlyAdded`/`stats` are deliberately install-wide. Inbox and review books
 * are not: they are pre-approval uploads, and `/api/inbox*` already refuses to
 * list or show one the caller does not own. These two endpoints were the holes
 * left in that boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { createMemoryKVStore } from "../../services/kv-store.js";

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

function seedUserKey(name: string, role: "user" | "admin" = "user") {
  return seedAppPassword(createTestAuth(db, TEST_ENV), db, { name, role });
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
      auth: createTestAuth(db, TEST_ENV),
      shutdown: async () => {},
    },
    env: TEST_ENV,
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
});

describe("GET /api/dashboard", () => {
  it("counts only the caller's own inbox/review books, and matches /api/inbox/count", async () => {
    const alice = await seedUserKey("Dashboard Alice");
    const bob = await seedUserKey("Dashboard Bob");

    // Alice has three pending uploads; Bob has none.
    await db.insert(schema.books).values([
      { status: "review", title: "Alice Review One", createdBy: alice.userId },
      { status: "review", title: "Alice Review Two", createdBy: alice.userId },
      { status: "inbox", title: "Alice Inbox One", createdBy: alice.userId },
      { status: "organized", title: "Shared Organized", createdBy: alice.userId },
    ]);

    const { app } = createTestApp();

    const bobDashboard = await app.request("/api/dashboard", {
      headers: { Authorization: `Bearer ${bob.rawKey}` },
    });
    expect(bobDashboard.status).toBe(200);
    const bobBody = await bobDashboard.json();

    // Pre-fix this was 3 — a bare count() over every user's pending uploads.
    expect(bobBody.inboxCount).toBe(0);

    // ...and it now agrees with the owner-scoped endpoint feeding the sidebar.
    const bobInboxCount = await app.request("/api/inbox/count", {
      headers: { Authorization: `Bearer ${bob.rawKey}` },
    });
    expect((await bobInboxCount.json()).count).toBe(bobBody.inboxCount);

    // The shared organized library is still install-wide for Bob.
    expect(bobBody.stats.totalBooks).toBe(1);
    expect(bobBody.recentlyAdded).toHaveLength(1);

    const aliceDashboard = await app.request("/api/dashboard", {
      headers: { Authorization: `Bearer ${alice.rawKey}` },
    });
    expect((await aliceDashboard.json()).inboxCount).toBe(3);
  });

  it("still reports the install-wide inbox count to an admin", async () => {
    const alice = await seedUserKey("Dashboard Admin Alice");
    const admin = await seedUserKey("Dashboard Admin", "admin");

    await db.insert(schema.books).values([
      { status: "review", title: "Alice Pending", createdBy: alice.userId },
      { status: "inbox", title: "Admin Pending", createdBy: admin.userId },
    ]);

    const { app } = createTestApp();
    const response = await app.request("/api/dashboard", {
      headers: { Authorization: `Bearer ${admin.rawKey}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).inboxCount).toBe(2);
  });
});
