/**
 * Route cache invalidation degrades instead of failing the request (libris-hs5).
 *
 * The durable write has already committed by the time a route calls
 * `invalidateRouteCache`, so a KV outage must not turn a successful mutation
 * into a 500. Swallowing alone would be wrong though: a stale entry that
 * outlives the outage serves wrong data. These tests pin both halves — the
 * degrade *and* the compensation that bounds how long the staleness can last.
 */
import { Hono } from "hono";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../app.js";
import type { AppVariables } from "../context.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { cachedRoute } from "../middleware/cache.js";
import {
  type CachedRoutePrefix,
  getDeferredInvalidations,
  invalidateRouteCache,
  resetDeferredInvalidations,
} from "./cache.js";
import { createMemoryKVStore, type KVStore } from "./kv-store.js";

vi.mock("./redis.js", () => ({
  isRedisHealthy: async () => ({ ok: true, latencyMs: 1 }),
  getSharedRedis: () => null,
}));

vi.mock("./queue.js", () => ({
  getQueues: () => ({ close: async () => {} }),
  getAllQueues: () => new Map(),
  registerQueue: () => {},
}));

vi.mock("./event-bus.js", () => ({
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

/**
 * A KV store that can be knocked offline the way Redis goes offline: every
 * operation rejects, and the data it already holds survives to be served again
 * once it comes back. That surviving data is the staleness this fix has to
 * bound.
 */
function createFlakyKVStore(): KVStore & { down: boolean } {
  const inner = createMemoryKVStore();
  const store: KVStore & { down: boolean } = {
    down: false,
    async getItem(key: string) {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.getItem(key);
    },
    async setItem(key: string, value: unknown, opts?: { ttl?: number }) {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.setItem(key, value, opts);
    },
    async increment(key: string, ttl: number) {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.increment(key, ttl);
    },
    async getKeys(base?: string) {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.getKeys(base);
    },
    async removeItem(key: string) {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.removeItem(key);
    },
    async clear() {
      if (store.down) throw new Error("ECONNREFUSED");
      return inner.clear();
    },
  };
  return store;
}

describe("invalidateRouteCache", () => {
  it("removes matching route keys and leaves the rest alone", async () => {
    const store = createMemoryKVStore();
    await store.setItem("routes:/opds/books:user:alice", { body: "x" });
    await store.setItem("routes:/opds/books?page=2:user:alice", { body: "y" });
    await store.setItem("routes:/api/stats:user:alice", { body: "z" });

    await invalidateRouteCache(store, "/opds");

    expect(await store.getKeys()).toEqual(["routes:/api/stats:user:alice"]);
  });

  it("does not reject when the KV store is down", async () => {
    const store = createFlakyKVStore();
    resetDeferredInvalidations(store);
    store.down = true;

    // Pre-fix this rejected with ECONNREFUSED, which routes turned into a 500
    // on a mutation whose database write had already committed.
    await expect(invalidateRouteCache(store, "/opds")).resolves.toBeUndefined();
  });

  it("defers the failed prefix rather than dropping it", async () => {
    const store = createFlakyKVStore();
    resetDeferredInvalidations(store);
    store.down = true;

    await invalidateRouteCache(store, "/opds", "/api/stats");

    // The compensation: a swallowed invalidation is remembered, so the stale
    // entry cannot survive the outage unnoticed.
    expect(getDeferredInvalidations(store)).toEqual(["/opds", "/api/stats"]);
  });

  it("drains the deferred backlog on the next call once the store recovers", async () => {
    const store = createFlakyKVStore();
    resetDeferredInvalidations(store);
    await store.setItem("routes:/opds/new:user:alice", { body: "stale" });

    store.down = true;
    await invalidateRouteCache(store, "/opds");
    // The entry written before the outage is still there — that is the staleness.
    store.down = false;
    expect(await store.getItem("routes:/opds/new:user:alice")).not.toBeNull();

    // A later, unrelated mutation is enough to clear it.
    await invalidateRouteCache(store, "/api/stats");

    expect(await store.getItem("routes:/opds/new:user:alice")).toBeNull();
    expect(getDeferredInvalidations(store)).toEqual([]);
  });

  it("retries the backlog on a timer, without waiting for more traffic", async () => {
    vi.useFakeTimers();
    try {
      const store = createFlakyKVStore();
      resetDeferredInvalidations(store);
      await store.setItem("routes:/opds/new:user:alice", { body: "stale" });

      store.down = true;
      await invalidateRouteCache(store, "/opds");
      expect(getDeferredInvalidations(store)).toEqual(["/opds"]);

      // Still failing after the first retry tick: the backlog is kept.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getDeferredInvalidations(store)).toEqual(["/opds"]);

      store.down = false;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(getDeferredInvalidations(store)).toEqual([]);
      expect(await store.getItem("routes:/opds/new:user:alice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the deferred backlog so an outage cannot grow it without bound", async () => {
    const store = createFlakyKVStore();
    resetDeferredInvalidations(store);
    store.down = true;

    // Per-book prefixes are the unbounded case: not a fixed set, so a bulk
    // import during an outage could grow the backlog without a cap.
    const prefixes = Array.from(
      { length: 300 },
      (_, i): CachedRoutePrefix => `/opds/books/book-${i}`,
    );
    await invalidateRouteCache(store, ...prefixes);

    const deferred = getDeferredInvalidations(store);
    expect(deferred).toHaveLength(256);
    // The oldest are evicted first; those fall back to the entry TTL.
    expect(deferred[0]).toBe("/opds/books/book-44");
    expect(deferred.at(-1)).toBe("/opds/books/book-299");

    resetDeferredInvalidations(store);
  });
});

describe("cachedRoute TTL backstop", () => {
  it("writes every cached entry with a ttl, bounding a dropped invalidation", async () => {
    const writes: { key: string; opts?: { ttl?: number } }[] = [];
    const inner = createMemoryKVStore();
    const store: KVStore = {
      ...inner,
      async setItem(key, value, opts) {
        writes.push({ key, opts });
        return inner.setItem(key, value, opts);
      },
    };

    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("userId", "alice");
      c.set("cacheStorage", store);
      await next();
    });
    app.get("/opds/new", cachedRoute({ maxAge: 60 }), (c) => c.text("feed"));

    const response = await app.request("/opds/new");
    expect(response.status).toBe(200);

    // Without a TTL a lost invalidation would be permanent. With one, the worst
    // case staleness is maxAge even if the deferred retry never runs.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.opts?.ttl).toBe(60);
  });
});

describe("a mutating route under a KV outage", () => {
  let pglite: PGlite;
  let db: TestDb;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pglite = testDb.pglite;
    db = testDb.db;
  });

  afterAll(async () => {
    await pglite.close();
  });

  it("still applies and reports success (PATCH /api/library/{id})", async () => {
    const cacheStorage = createFlakyKVStore();
    resetDeferredInvalidations(cacheStorage);

    const auth = createTestAuth(db, TEST_ENV);
    // This test used to drive PATCH /api/settings, which no longer invalidates
    // anything: nothing under /api/settings is cached, so the call was a no-op
    // and could not exercise the outage path (libris-kej). PATCH
    // /api/library/{id} does invalidate — /opds and /api/stats — so it is the
    // route that actually puts a KV write in the way of a committed DB write.
    const { userId, rawKey } = await seedAppPassword(auth, db, { name: "Cache Outage" });
    const [book] = await db
      .insert(schema.books)
      .values({ status: "organized", title: "Before", createdBy: userId })
      .returning({ id: schema.books.id });

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
        },
        redisStorage: createMemoryKVStore(),
        cacheStorage,
        auth,
        shutdown: async () => {},
      },
      env: TEST_ENV,
    });

    cacheStorage.down = true;

    const response = await app.request(`/api/library/${book.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "After" }),
    });

    // Pre-fix: 500. The title was written to Postgres and the caller was told
    // the request failed.
    expect(response.status).toBe(200);
    expect((await response.json()).title).toBe("After");

    // ...and the invalidations it could not perform are queued for retry.
    expect(getDeferredInvalidations(cacheStorage)).toEqual(["/opds", "/api/stats"]);
    resetDeferredInvalidations(cacheStorage);
  });
});
