import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { sealToken } from "../../shared/auth.js";

// Stub the metadata client so the route handler is the unit under test —
// searchHardcover itself is covered by metadata-clients.test.ts.
const searchHardcoverMock = vi.fn();
vi.mock("../../lib/metadata/clients/hardcover.js", () => ({
  searchHardcover: (...args: unknown[]) => searchHardcoverMock(...args),
}));

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

async function seedApiKey(name = "Hardcover Test Key") {
  // A real Better Auth app password: the key column holds a hash the plugin
  // computes, so a hand-written api_keys row cannot authenticate.
  return await seedAppPassword(createTestAuth(db, TEST_ENV), db, { name });
}

async function seedHardcoverCredential(userId: string, token = "test-token") {
  const sealed = await sealToken(token, TEST_ENV.API_SECRET_KEY);
  await db.insert(schema.serviceCredentials).values({
    service: "hardcover",
    userId,
    username: `hc-user-${userId}`,
    passwordHash: sealed,
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

beforeEach(async () => {
  searchHardcoverMock.mockReset();
  // Wipe per-test state so each case starts from defaults.
  await db.delete(schema.appSettings);
  await db.delete(schema.serviceCredentials);
  await db.delete(schema.apiKeys);
});

describe("GET /api/hardcover/search", () => {
  it("returns search results when credential is configured and metadata is enabled", async () => {
    const { userId, rawKey } = await seedApiKey();
    await seedHardcoverCredential(userId);

    searchHardcoverMock.mockResolvedValueOnce([
      {
        source: "hardcover",
        normalized: { title: "Dune", author: "Frank Herbert", publishedYear: 1965 },
        rawResponse: { id: 1 },
        confidence: 0.88,
      },
    ]);

    const { app } = createTestApp();
    const response = await app.request("/api/hardcover/search?q=dune", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ source: string; normalized: { title?: string }; confidence: number }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.source).toBe("hardcover");
    expect(body.results[0]?.normalized.title).toBe("Dune");
    expect(body.results[0]?.confidence).toBe(0.88);
    // The caller's own token is threaded through, so the client cannot resolve
    // an arbitrary one from the credentials table.
    expect(searchHardcoverMock).toHaveBeenCalledWith({ title: "dune" }, { token: "test-token" });
  });

  it("refuses to spend another user's token for a caller with no credential", async () => {
    // Alice connects her personal Hardcover account. Bob never does.
    const alice = await seedApiKey("Hardcover Alice");
    const bob = await seedApiKey("Hardcover Bob");
    await seedHardcoverCredential(alice.userId, "alice-personal-token");

    const { app } = createTestApp();

    const bobSearch = await app.request("/api/hardcover/search?q=dune", {
      headers: { Authorization: `Bearer ${bob.rawKey}` },
    });

    // Pre-fix: the gate was a bare `service = 'hardcover'` — "does anyone on
    // this server have a token" — so Bob's request sailed past it and Alice's
    // token paid for the search. This is the load-bearing assertion: a user
    // with no credential must not cause a Hardcover API call at all.
    expect(searchHardcoverMock).not.toHaveBeenCalled();
    expect(bobSearch.status).toBe(503);

    // /status and /search now agree about whether Bob is connected.
    const bobStatus = await app.request("/api/hardcover/status", {
      headers: { Authorization: `Bearer ${bob.rawKey}` },
    });
    expect((await bobStatus.json()).connected).toBe(false);

    // Alice, who does have a credential, still gets results — on her own token.
    searchHardcoverMock.mockResolvedValueOnce([]);
    const aliceSearch = await app.request("/api/hardcover/search?q=dune", {
      headers: { Authorization: `Bearer ${alice.rawKey}` },
    });
    expect(aliceSearch.status).toBe(200);
    expect(searchHardcoverMock).toHaveBeenCalledExactlyOnceWith(
      { title: "dune" },
      { token: "alice-personal-token" },
    );
  });

  it("returns 503 when no Hardcover credential is configured", async () => {
    const { rawKey } = await seedApiKey();

    const { app } = createTestApp();
    const response = await app.request("/api/hardcover/search?q=dune", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(503);
    expect(searchHardcoverMock).not.toHaveBeenCalled();
  });

  it("returns 503 when hardcover.metadataEnabled is false", async () => {
    const { userId, rawKey } = await seedApiKey();
    await seedHardcoverCredential(userId);
    await db.insert(schema.appSettings).values({
      key: "hardcover.metadataEnabled",
      value: false,
    });

    const { app } = createTestApp();
    const response = await app.request("/api/hardcover/search?q=dune", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(503);
    expect(searchHardcoverMock).not.toHaveBeenCalled();
  });

  it("rejects queries shorter than 2 characters", async () => {
    const { userId, rawKey } = await seedApiKey();
    await seedHardcoverCredential(userId);

    const { app } = createTestApp();
    const response = await app.request("/api/hardcover/search?q=a", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(400);
    expect(searchHardcoverMock).not.toHaveBeenCalled();
  });
});
