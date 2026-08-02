import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { createMemoryKVStore } from "../../services/kv-store.js";

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

async function seedApiKey(label = "Library Test Key") {
  const seeded = await seedAppPassword(createTestAuth(db, TEST_ENV), db, { name: label });
  return { ...seeded, label };
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

/** Build an app that records every BOOK_ORGANIZE job enqueued. */
function createOrganizeRecordingApp() {
  const organizeJobs: { bookId: string; forceRedownloadCover?: boolean }[] = [];
  const { app } = createApp({
    services: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      queues: {
        bookDetected: { add: async () => ({}) },
        bookParseFile: { add: async () => ({}) },
        bookFetchMetadata: { add: async () => ({}) },
        bookOrganize: {
          add: async (
            _name: string,
            payload: { bookId: string; forceRedownloadCover?: boolean },
          ) => {
            organizeJobs.push(payload);
            return {};
          },
        },
        close: async () => {},
      },
      redisStorage: createMemoryKVStore(),
      cacheStorage: createMemoryKVStore(),
      auth: createTestAuth(db, TEST_ENV),
      shutdown: async () => {},
    },
    env: TEST_ENV,
  });
  return { app, organizeJobs };
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

describe("GET /api/library", () => {
  it("returns uploader labels in list responses without exposing api key fields", async () => {
    const { userId, rawKey, label } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Uploaded Book",
        author: "Uploader Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "uploaded-book.epub",
      storagePath: "Uploaded Author/Uploaded Book.epub",
      fileSize: 1234,
    });

    const { app } = createTestApp();
    const response = await app.request("/api/library", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].uploader).toEqual({ id: userId, label });
    expect(body.data[0].uploader).not.toHaveProperty("key");
    expect(body.data[0].uploader).not.toHaveProperty("keyPrefix");
    expect(body.data[0].uploader).not.toHaveProperty("keyHash");
    expect(body.data[0].uploader).not.toHaveProperty("isAdmin");
    expect(body.data[0].uploader).not.toHaveProperty("lastUsedAt");
  });

  it("returns uploader labels in detail responses", async () => {
    const { userId, rawKey, label } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Detail Book",
        author: "Detail Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "detail-book.epub",
      storagePath: "Detail Author/Detail Book.epub",
      fileSize: 5678,
    });

    const { app } = createTestApp();
    const response = await app.request(`/api/library/${book.id}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.uploader).toEqual({ id: userId, label });
    expect(body.uploader).not.toHaveProperty("key");
    expect(body.uploader).not.toHaveProperty("keyPrefix");
    expect(body.uploader).not.toHaveProperty("keyHash");
    expect(body.uploader).not.toHaveProperty("isAdmin");
    expect(body.uploader).not.toHaveProperty("lastUsedAt");
  });

  it("filters by language and uploader and returns matching facets", async () => {
    const uploaderA = await seedApiKey("Uploader A");
    const uploaderB = await seedApiKey("Uploader B");

    await db.insert(schema.books).values([
      {
        status: "organized",
        title: "English Book",
        author: "Author A",
        language: "en",
        createdBy: uploaderA.userId,
        genres: ["Sci-Fi"],
      },
      {
        status: "organized",
        title: "French Book",
        author: "Author B",
        language: "fr",
        createdBy: uploaderB.userId,
        genres: ["Fantasy"],
      },
    ]);

    const { app } = createTestApp();
    const filteredResponse = await app.request(
      `/api/library?language=en&uploaderId=${uploaderA.userId}`,
      {
        headers: { Authorization: `Bearer ${uploaderA.rawKey}` },
      },
    );

    expect(filteredResponse.status).toBe(200);
    const filteredBody = await filteredResponse.json();
    expect(filteredBody.data).toHaveLength(1);
    expect(filteredBody.data[0].title).toBe("English Book");
    expect(filteredBody.data[0].uploader).toEqual({
      id: uploaderA.userId,
      label: uploaderA.label,
    });

    const facetsResponse = await app.request("/api/library/facets", {
      headers: { Authorization: `Bearer ${uploaderA.rawKey}` },
    });

    expect(facetsResponse.status).toBe(200);
    const facetsBody = await facetsResponse.json();
    expect(facetsBody.languages).toEqual(expect.arrayContaining(["en", "fr"]));
    expect(facetsBody.uploaders).toEqual(
      expect.arrayContaining([
        { id: uploaderA.userId, label: uploaderA.label },
        { id: uploaderB.userId, label: uploaderB.label },
      ]),
    );
  });
});

describe("GET /api/library/sync", () => {
  it("returns 401 without auth", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/library/sync");
    expect(response.status).toBe(401);
  });

  it("returns each organised book with the per-book progress aggregate", async () => {
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Synced Book",
        author: "Sync Author",
        description: "A book for the sync test.",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });
    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "synced-book.epub",
      storagePath: "Sync Author/Synced Book.epub",
      contentHash: "hash-1",
      fileSize: 1024,
    });
    // One progress row at 42% from "kobo".
    await db.insert(schema.readingProgress).values({
      bookId: book.id,
      userId,
      document: "hash-1",
      device: "kobo",
      progress: "page=42",
      percentage: "0.4200",
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    });

    const { app } = createTestApp();
    const response = await app.request("/api/library/sync", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(typeof body.serverTime).toBe("string");

    const synced = body.data.find((b: { id: string }) => b.id === book.id);
    expect(synced).toBeDefined();
    expect(synced.description).toBe("A book for the sync test.");
    expect(synced.files).toHaveLength(1);
    expect(synced.progress).toMatchObject({
      percentage: 0.42,
      status: "reading",
      lastDevice: "kobo",
    });
    expect(typeof synced.progress.lastTimestamp).toBe("number");
  });

  it("reports progress as `unread` with null fields for books with no progress rows", async () => {
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Untouched Book",
        author: "Quiet Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    const { app } = createTestApp();
    const response = await app.request("/api/library/sync", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    const body = await response.json();
    const record = body.data.find((b: { id: string }) => b.id === book.id);
    expect(record.progress).toEqual({
      percentage: null,
      status: "unread",
      lastDevice: null,
      lastTimestamp: null,
      startedAt: null,
      finishedAt: null,
      pausedAt: null,
      manuallySet: false,
      externallySet: false,
    });
  });

  it("includes startedAt and finishedAt from reading_aggregate", async () => {
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Lifecycle Book",
        author: "Lifecycle Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    const startedAt = new Date("2026-04-01T12:00:00.000Z");
    const finishedAt = new Date("2026-04-15T18:30:00.000Z");
    await db.insert(schema.readingAggregate).values({
      userId,
      bookId: book.id,
      startedAt,
      finishedAt,
    });

    const { app } = createTestApp();
    const response = await app.request("/api/library/sync", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    const body = await response.json();
    const record = body.data.find((b: { id: string }) => b.id === book.id);
    expect(record.progress.startedAt).toBe(startedAt.toISOString());
    expect(record.progress.finishedAt).toBe(finishedAt.toISOString());
  });

  it("filters by ?since to books whose updatedAt is more recent", async () => {
    const { rawKey, userId } = await seedApiKey();

    // Insert an old book, then take a timestamp, then insert a new book.
    await db.insert(schema.books).values({
      status: "organized",
      createdBy: userId,
      title: "Old Sync Book",
      author: "Old Author",
    });
    // Force separation in time so the >  comparator sees the cutoff cleanly.
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const [newer] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        createdBy: userId,
        title: "New Sync Book",
        author: "New Author",
      })
      .returning({ id: schema.books.id });

    const { app } = createTestApp();
    const response = await app.request(`/api/library/sync?since=${encodeURIComponent(cutoff)}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const titles = body.data.map((b: { title: string }) => b.title);
    expect(titles).toContain("New Sync Book");
    expect(titles).not.toContain("Old Sync Book");
    expect(body.data.some((b: { id: string }) => b.id === newer.id)).toBe(true);
  });

  it("does not match `/sync` against the `/{id}` route", async () => {
    // Regression: the literal `/sync` route is registered before `/{id}`. If the
    // ordering ever changes, `/sync` would be treated as a uuid and 422/404.
    const { rawKey } = await seedApiKey();
    const { app } = createTestApp();
    const response = await app.request("/api/library/sync", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("Manual reading status override", () => {
  async function seedBook(userId: string, title = "Status Book") {
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title,
        author: "Status Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });
    return book.id;
  }

  it("PATCH sets a manual override and GET reflects it", async () => {
    const { userId, rawKey } = await seedApiKey("Status PATCH");
    const bookId = await seedBook(userId);

    const { app } = createTestApp();
    const patch = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: "finished",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-02-01T00:00:00.000Z",
      }),
    });
    expect(patch.status).toBe(200);
    const patchBody = await patch.json();
    expect(patchBody.status).toBe("finished");
    expect(patchBody.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(patchBody.finishedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(patchBody.manuallySet).toBe(true);

    const get = await app.request(`/api/library/${bookId}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    const getBody = await get.json();
    expect(getBody.progress.status).toBe("finished");
    expect(getBody.progress.manuallySet).toBe(true);
  });

  it("PATCH rejects future dates", async () => {
    const { userId, rawKey } = await seedApiKey("Status Future");
    const bookId = await seedBook(userId);

    const { app } = createTestApp();
    const future = new Date(Date.now() + 86400_000).toISOString();
    const res = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "finished", finishedAt: future }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects finishedAt before startedAt", async () => {
    const { userId, rawKey } = await seedApiKey("Status Inverted");
    const bookId = await seedBook(userId);

    const { app } = createTestApp();
    const res = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: "finished",
        startedAt: "2026-02-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE clears the manual override and GET reverts to computed status", async () => {
    const { userId, rawKey } = await seedApiKey("Status Clear");
    const bookId = await seedBook(userId);

    const { app } = createTestApp();
    // Apply a sticky override.
    await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "finished", finishedAt: "2026-02-01T00:00:00.000Z" }),
    });

    const del = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.manuallySet).toBe(false);
    // No progress recorded → computed default is unread.
    expect(delBody.status).toBe("unread");

    const get = await app.request(`/api/library/${bookId}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    const getBody = await get.json();
    expect(getBody.progress.manuallySet).toBe(false);
    expect(getBody.progress.status).toBe("unread");
  });

  it("PATCH unread clears all manual dates", async () => {
    const { userId, rawKey } = await seedApiKey("Status Unread");
    const bookId = await seedBook(userId);

    const { app } = createTestApp();
    await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        status: "finished",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-02-01T00:00:00.000Z",
      }),
    });

    const reset = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "unread" }),
    });
    expect(reset.status).toBe(200);
    const body = await reset.json();
    expect(body.status).toBe("unread");
    expect(body.startedAt).toBeNull();
    expect(body.finishedAt).toBeNull();
    expect(body.pausedAt).toBeNull();
    // The user actively chose "unread" — that's still a manual override.
    expect(body.manuallySet).toBe(true);
  });
});

describe("PATCH /api/library/:id re-organize on metadata edits", () => {
  async function seedOrganizedBook(userId: string) {
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "organized",
        title: "Original Title",
        author: "Original Author",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "book.epub",
      storagePath: "Original Author/Original Title.epub",
      fileSize: 1234,
    });

    return book.id;
  }

  async function patch(
    app: ReturnType<typeof createOrganizeRecordingApp>["app"],
    rawKey: string,
    id: string,
    body: unknown,
  ) {
    return app.request(`/api/library/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("re-organizes when an embedded field (title) changes, without forcing a cover re-download", async () => {
    const { userId, rawKey } = await seedApiKey();
    const bookId = await seedOrganizedBook(userId);
    const { app, organizeJobs } = createOrganizeRecordingApp();

    const res = await patch(app, rawKey, bookId, { title: "Updated Title" });

    expect(res.status).toBe(200);
    expect(organizeJobs).toEqual([{ bookId, forceRedownloadCover: false }]);
  });

  it("forces a cover re-download when coverUrl changes", async () => {
    const { userId, rawKey } = await seedApiKey();
    const bookId = await seedOrganizedBook(userId);
    const { app, organizeJobs } = createOrganizeRecordingApp();

    const res = await patch(app, rawKey, bookId, {
      coverUrl: "https://example.com/new-cover.jpg",
    });

    expect(res.status).toBe(200);
    expect(organizeJobs).toEqual([{ bookId, forceRedownloadCover: true }]);
  });

  it("does NOT re-organize when only non-embedded fields (tags) change", async () => {
    const { userId, rawKey } = await seedApiKey();
    const bookId = await seedOrganizedBook(userId);
    const { app, organizeJobs } = createOrganizeRecordingApp();

    const res = await patch(app, rawKey, bookId, { tags: ["favourite"] });

    expect(res.status).toBe(200);
    expect(organizeJobs).toEqual([]);
  });
});
