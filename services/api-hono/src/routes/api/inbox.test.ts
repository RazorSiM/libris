import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { generateApiKey } from "../../shared/auth.js";

let pglite: PGlite;
let db: TestDb;

async function seedApiKey() {
  const key = await generateApiKey();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      keyPrefix: key.keyPrefix,
      keyHash: key.keyHash,
      label: "Inbox Test Key",
      isAdmin: false,
    })
    .returning({ id: schema.apiKeys.id });

  return { apiKeyId: row.id, rawKey: key.rawKey };
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

describe("POST /api/inbox/upload", () => {
  it("keeps the existing file and writes a collision-safe unique name", async () => {
    const { apiKeyId, rawKey } = await seedApiKey();
    const inboxPath = await mkdtemp(join(tmpdir(), "libris-inbox-upload-"));
    const originalPath = join(inboxPath, "same.epub");

    await writeFile(originalPath, Buffer.from("existing content"));

    const env: Env = {
      NODE_ENV: "test",
      PORT: 3000,
      DATABASE_URL: "pglite://",
      REDIS_URL: "redis://localhost:6379",
      LIBRIS_INBOX_PATH: inboxPath,
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
        cacheStorage: createMemoryKVStore(),
        auth: createTestAuth(db, env),
        shutdown: async () => {},
      },
      env,
    });

    const form = new FormData();
    form.append(
      "file",
      new File([Buffer.from("new content")], "same.epub", {
        type: "application/epub+zip",
      }),
    );

    const response = await app.request("/api/inbox/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      body: form,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uploaded: [{ filename: "same.epub", size: 11 }],
      errors: [],
    });

    await expect(readFile(originalPath, "utf-8")).resolves.toBe("existing content");

    const inboxEntries = await readdir(inboxPath);
    expect(inboxEntries.sort()).toEqual(["same-1.epub", "same.epub"]);
    await expect(readFile(join(inboxPath, "same-1.epub"), "utf-8")).resolves.toBe("new content");

    const [registryRow] = await db
      .select({
        filename: schema.uploadRegistry.filename,
        apiKeyId: schema.uploadRegistry.apiKeyId,
      })
      .from(schema.uploadRegistry)
      .where(eq(schema.uploadRegistry.apiKeyId, apiKeyId));

    expect(registryRow).toEqual({ filename: "same.epub", apiKeyId });

    await rm(inboxPath, { recursive: true, force: true });
  });
});

describe("PATCH /api/inbox/:id/rescan", () => {
  it("deletes candidates and resets status atomically in a transaction", async () => {
    const { apiKeyId, rawKey } = await seedApiKey();

    // Create a book in "review" status owned by our API key
    const [book] = await db
      .insert(schema.books)
      .values({ status: "review", title: "Test Book", author: "Author", createdBy: apiKeyId })
      .returning({ id: schema.books.id });

    // Insert a "file" candidate (should be preserved) and a "google" candidate (should be deleted)
    await db.insert(schema.bookMetadataCandidates).values([
      { bookId: book.id, source: "file", normalized: { title: "From File" }, confidence: "1.0" },
      {
        bookId: book.id,
        source: "google",
        normalized: { title: "From Google" },
        confidence: "0.8",
      },
    ]);

    const fetchMetadataAdd = vi.fn().mockResolvedValue({});

    const env: Env = {
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

    const { app } = createApp({
      services: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: db as any,
        queues: {
          bookDetected: { add: async () => ({}) },
          bookParseFile: { add: async () => ({}) },
          bookFetchMetadata: { add: fetchMetadataAdd },
          bookOrganize: { add: async () => ({}) },
          close: async () => {},
        },
        redisStorage: createMemoryKVStore(),
        cacheStorage: createMemoryKVStore(),
        auth: createTestAuth(db, env),
        shutdown: async () => {},
      },
      env,
    });

    const response = await app.request(`/api/inbox/${book.id}/rescan`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("rescanning");
    expect(body.bookId).toBe(book.id);

    // Verify: book status was reset to "inbox"
    const [updatedBook] = await db
      .select({ status: schema.books.status })
      .from(schema.books)
      .where(eq(schema.books.id, book.id));
    expect(updatedBook.status).toBe("inbox");

    // Verify: non-file candidates were deleted, file candidate preserved
    const remainingCandidates = await db
      .select({ source: schema.bookMetadataCandidates.source })
      .from(schema.bookMetadataCandidates)
      .where(eq(schema.bookMetadataCandidates.bookId, book.id));

    expect(remainingCandidates).toHaveLength(1);
    expect(remainingCandidates[0].source).toBe("file");

    // Verify: metadata fetch job was enqueued AFTER the transaction
    expect(fetchMetadataAdd).toHaveBeenCalledOnce();
    expect(fetchMetadataAdd).toHaveBeenCalledWith("fetch-metadata", {
      bookId: book.id,
      searchQuery: "Test Book by Author",
    });
  });
});

describe("GET /api/inbox", () => {
  it("returns uploader labels in list and detail responses without exposing api key fields", async () => {
    const { apiKeyId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "review",
        title: "Inbox Book",
        author: "Inbox Author",
        createdBy: apiKeyId,
      })
      .returning({ id: schema.books.id });

    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "inbox-book.epub",
      inboxPath: "/tmp/libris-test-inbox/inbox-book.epub",
      fileSize: 4321,
    });

    const env: Env = {
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
        cacheStorage: createMemoryKVStore(),
        auth: createTestAuth(db, env),
        shutdown: async () => {},
      },
      env,
    });

    const listResponse = await app.request("/api/inbox", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    const listedBook = listBody.data.find((item: { id: string }) => item.id === book.id);
    expect(listedBook).toBeDefined();
    expect(listedBook.uploader).toEqual({ id: apiKeyId, label: "Inbox Test Key" });
    expect(listedBook.uploader).not.toHaveProperty("key");
    expect(listedBook.uploader).not.toHaveProperty("keyPrefix");
    expect(listedBook.uploader).not.toHaveProperty("keyHash");
    expect(listedBook.uploader).not.toHaveProperty("isAdmin");
    expect(listedBook.uploader).not.toHaveProperty("lastUsedAt");

    const detailResponse = await app.request(`/api/inbox/${book.id}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.uploader).toEqual({ id: apiKeyId, label: "Inbox Test Key" });
    expect(detailBody.uploader).not.toHaveProperty("key");
    expect(detailBody.uploader).not.toHaveProperty("keyPrefix");
    expect(detailBody.uploader).not.toHaveProperty("keyHash");
    expect(detailBody.uploader).not.toHaveProperty("isAdmin");
    expect(detailBody.uploader).not.toHaveProperty("lastUsedAt");
  });
});
