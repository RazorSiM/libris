import { createMemoryKVStore } from "../../services/kv-store.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
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

async function seedApiKey(options: { label: string; isAdmin: boolean }) {
  // isAdmin is a role on the USER now, not a flag on the credential.
  return await seedAppPassword(createTestAuth(db, TEST_ENV), db, {
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
    const { rawKey } = await seedApiKey({ label: "Admin Key", isAdmin: true });
    const { app } = createTestApp();

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${rawKey}` },
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
    const { rawKey } = await seedApiKey({ label: "Admin Key", isAdmin: true });

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
      headers: { Authorization: `Bearer ${rawKey}` },
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
    const { rawKey } = await seedApiKey({ label: "Regular Key", isAdmin: false });
    const { app } = createTestApp();

    const response = await app.request("/api/settings/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${rawKey}` },
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
});
