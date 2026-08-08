/**
 * Owner-scoping of everything on the dashboard that describes pre-approval work.
 *
 * The organized library is shared — `recentlyAdded`, `totalBooks`,
 * `totalAuthors`, `topGenre` and `totalFileSize` are deliberately install-wide,
 * because organized books belong to everyone. Inbox and review books are not:
 * they are pre-approval uploads, and every other inbox surface refuses to show
 * one the caller does not own. `inboxCount`, `totalFileSize`'s exclusion of
 * inbox/review files, `processingCount` and `pipeline` all follow from that
 * split.
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

/**
 * Queue doubles whose per-queue counts and in-flight book ids the tests drive.
 *
 * The install-wide counts and the job payloads have to come from the same
 * fixture, because the whole point is that the first is not a safe substitute
 * for the second when the caller is not an admin.
 */
const queueFixture = vi.hoisted(() => {
  const zero = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  const state: Record<string, { counts: typeof zero; bookIds: string[] }> = {};

  return {
    reset() {
      for (const key of Object.keys(state)) delete state[key];
    },
    set(name: string, opts: { counts?: Partial<typeof zero>; bookIds?: string[] }) {
      state[name] = { counts: { ...zero, ...opts.counts }, bookIds: opts.bookIds ?? [] };
    },
    queue(name: string) {
      return {
        name,
        add: async () => ({}),
        getJobCounts: async () => state[name]?.counts ?? zero,
        getJobs: async () => (state[name]?.bookIds ?? []).map((bookId) => ({ data: { bookId } })),
        isPaused: async () => false,
      };
    },
  };
});

vi.mock("../../services/queue.js", () => ({
  getQueues: () => ({
    bookDetected: queueFixture.queue("book-detected"),
    bookParseFile: queueFixture.queue("book-parse-file"),
    bookFetchMetadata: queueFixture.queue("book-fetch-metadata"),
    bookOrganize: queueFixture.queue("book-organize"),
    close: async () => {},
  }),
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
  // Same doubles the module mock hands to getPipelineQueues(), so the
  // owner-scoped path and the install-wide path see one consistent world.
  const queues = {
    bookDetected: queueFixture.queue("book-detected"),
    bookParseFile: queueFixture.queue("book-parse-file"),
    bookFetchMetadata: queueFixture.queue("book-fetch-metadata"),
    bookOrganize: queueFixture.queue("book-organize"),
    close: async () => {},
  };

  return createApp({
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      queues,
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
  queueFixture.reset();
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

  it("leaves other users' pre-approval uploads out of the byte total", async () => {
    const alice = await seedUserKey("Bytes Alice");
    const bob = await seedUserKey("Bytes Bob");
    const admin = await seedUserKey("Bytes Admin", "admin");

    const [pending, shared] = await db
      .insert(schema.books)
      .values([
        { status: "review", title: "Alice Pending Upload", createdBy: alice.userId },
        { status: "organized", title: "Shared Organized", createdBy: alice.userId },
      ])
      .returning({ id: schema.books.id });

    await db.insert(schema.bookFiles).values([
      {
        bookId: pending!.id,
        format: "epub",
        originalName: "pending.epub",
        fileSize: 5_000_000,
      },
      {
        bookId: shared!.id,
        format: "epub",
        originalName: "shared.epub",
        fileSize: 1_000_000,
      },
    ]);

    const { app } = createTestApp();
    const read = async (key: string) =>
      (await (
        await app.request("/api/dashboard", { headers: { Authorization: `Bearer ${key}` } })
      ).json()) as {
        stats: { totalFileSize: number; totalBooks: number };
      };

    // Pre-fix this was 6_000_000 for everyone: a bare sum over book_files told
    // Bob exactly how many bytes of unapproved uploads Alice was sitting on.
    expect((await read(bob.rawKey)).stats.totalFileSize).toBe(1_000_000);

    // "The shared library", not "mine": the number means the same thing for
    // the owner of the pending upload and for an admin, and it stays coherent
    // with totalBooks beside it, which has always counted organized rows only.
    expect((await read(alice.rawKey)).stats.totalFileSize).toBe(1_000_000);
    expect((await read(admin.rawKey)).stats.totalFileSize).toBe(1_000_000);
    expect((await read(bob.rawKey)).stats.totalBooks).toBe(1);
  });

  it("counts only the caller's own books as processing, and hides the queue breakdown", async () => {
    const alice = await seedUserKey("Pipeline Alice");
    const bob = await seedUserKey("Pipeline Bob");
    const admin = await seedUserKey("Pipeline Admin", "admin");

    const [aliceOne, aliceTwo, bobBook] = await db
      .insert(schema.books)
      .values([
        { status: "review", title: "Alice In Flight One", createdBy: alice.userId },
        { status: "inbox", title: "Alice In Flight Two", createdBy: alice.userId },
        { status: "inbox", title: "Bob In Flight", createdBy: bob.userId },
      ])
      .returning({ id: schema.books.id });

    // Three books in flight install-wide: two of Alice's, one of Bob's.
    queueFixture.set("book-parse-file", {
      counts: { waiting: 1, active: 1 },
      bookIds: [aliceOne!.id, bobBook!.id],
    });
    queueFixture.set("book-fetch-metadata", {
      counts: { delayed: 1 },
      // Also re-lists Alice's first book: one book queued at two stages must
      // not be counted twice.
      bookIds: [aliceOne!.id, aliceTwo!.id],
    });

    const { app } = createTestApp();
    const read = async (key: string) =>
      (await (
        await app.request("/api/dashboard", { headers: { Authorization: `Bearer ${key}` } })
      ).json()) as {
        stats: { processingCount: number };
        pipeline: Record<string, { waiting: number; active: number; failed: number }>;
      };

    const bobBody = await read(bob.rawKey);
    // Pre-fix: the full per-queue breakdown, including other users' failures.
    expect(bobBody.pipeline).toEqual({});
    // Pre-fix: 3 — the install-wide sum of waiting + active + delayed, which
    // told Bob that two books he cannot see were being processed.
    expect(bobBody.stats.processingCount).toBe(1);

    expect((await read(alice.rawKey)).stats.processingCount).toBe(2);

    // The admin still gets the install-wide diagnostics the settings page needs.
    const adminBody = await read(admin.rawKey);
    expect(adminBody.stats.processingCount).toBe(3);
    expect(adminBody.pipeline["book-parse-file"]).toMatchObject({ waiting: 1, active: 1 });
  });
});
