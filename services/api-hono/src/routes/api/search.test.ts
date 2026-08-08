/**
 * Owner-scoping of the command-palette suggest endpoint.
 *
 * Organized books are the shared library and match for everyone. Review books
 * are pre-approval uploads: /api/inbox refuses to list, show or serve the cover
 * of one the caller does not own, so suggest must not hand back their title,
 * author and cover either.
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

describe("GET /api/search/suggest", () => {
  /** Titles the suggest endpoint returned for `q`, as the given caller. */
  async function suggestTitles(
    app: ReturnType<typeof createTestApp>["app"],
    rawKey: string,
    q: string,
  ) {
    const response = await app.request(`/api/search/suggest?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { title: string | null }[] };
    return body.data.map((r) => r.title);
  }

  it("hides another user's review books but keeps organized books and your own", async () => {
    const alice = await seedUserKey("Suggest Alice");
    const bob = await seedUserKey("Suggest Bob");

    await db.insert(schema.books).values([
      // Alice's embarrassing pre-approval upload — Bob must not see it.
      { status: "review", title: "Zerbinax Private Draft", createdBy: alice.userId },
      // Bob's own pending upload — Bob must still see it.
      { status: "review", title: "Zerbinax Bob Draft", createdBy: bob.userId },
      // Shared library — everyone sees it.
      { status: "organized", title: "Zerbinax Shared Volume", createdBy: alice.userId },
    ]);

    const { app } = createTestApp();

    const bobTitles = await suggestTitles(app, bob.rawKey, "Zerbinax");
    // Pre-fix this contained "Zerbinax Private Draft": the query matched
    // status IN ('organized','review') with no owner predicate at all.
    expect(bobTitles).not.toContain("Zerbinax Private Draft");
    expect(bobTitles).toEqual(
      expect.arrayContaining(["Zerbinax Shared Volume", "Zerbinax Bob Draft"]),
    );

    const aliceTitles = await suggestTitles(app, alice.rawKey, "Zerbinax");
    expect(aliceTitles).toEqual(
      expect.arrayContaining(["Zerbinax Private Draft", "Zerbinax Shared Volume"]),
    );
    expect(aliceTitles).not.toContain("Zerbinax Bob Draft");
  });

  it("lets an admin suggest across every user's review books", async () => {
    const alice = await seedUserKey("Suggest Admin Alice");
    const admin = await seedUserKey("Suggest Admin", "admin");

    await db.insert(schema.books).values([
      { status: "review", title: "Quorbal Alice Draft", createdBy: alice.userId },
      { status: "organized", title: "Quorbal Shared Volume", createdBy: alice.userId },
    ]);

    const { app } = createTestApp();
    const titles = await suggestTitles(app, admin.rawKey, "Quorbal");
    expect(titles).toEqual(
      expect.arrayContaining(["Quorbal Alice Draft", "Quorbal Shared Volume"]),
    );
  });
});
