import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";

let pglite: PGlite;
let db: TestDb;

/**
 * Each test builds its own Env around a fresh tmpdir, but none of those paths
 * matter to auth — createTestAuth only reads the secret, NODE_ENV and the
 * cookie/proxy settings. A fixed env here lets the credential be seeded before
 * the per-test one exists.
 */
const AUTH_ENV = {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  COOKIE_DOMAIN: "",
  LIBRIS_COOKIE_SECURE: "0",
} as unknown as Env;

async function seedApiKey() {
  // A real Better Auth app password: the key column holds a hash the plugin
  // computes, so a hand-written api_keys row cannot authenticate.
  return await seedAppPassword(createTestAuth(db, AUTH_ENV), db, { name: "Inbox Test Key" });
}

function validEpubBytes(): Buffer {
  const name = Buffer.from("mimetype");
  const body = Buffer.from("application/epub+zip");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([header, name, body]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, eocd]);
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
    const { userId, rawKey } = await seedApiKey();
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
      LIBRIS_COVER_FETCH_ALLOWLIST: [],
      API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
      BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
      BETTER_AUTH_URL: "",
      COOKIE_DOMAIN: "",
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
    const epub = validEpubBytes();
    form.append(
      "file",
      new File([new Uint8Array(epub)], "same.epub", { type: "application/epub+zip" }),
    );

    const response = await app.request("/api/inbox/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      body: form,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uploaded: [{ filename: "same.epub", size: epub.length }],
      errors: [],
    });

    await expect(readFile(originalPath, "utf-8")).resolves.toBe("existing content");

    const inboxEntries = await readdir(inboxPath);
    expect(inboxEntries.sort()).toEqual(["same-1.epub", "same.epub"]);
    await expect(readFile(join(inboxPath, "same-1.epub"))).resolves.toEqual(epub);

    const [registryRow] = await db
      .select({
        filename: schema.uploadRegistry.filename,
        userId: schema.uploadRegistry.userId,
      })
      .from(schema.uploadRegistry)
      .where(eq(schema.uploadRegistry.userId, userId));

    expect(registryRow).toEqual({ filename: "same.epub", userId });

    await rm(inboxPath, { recursive: true, force: true });
  });

  it.each([
    ["empty.epub", Buffer.alloc(0), /empty/i],
    ["text.epub", Buffer.from("not a zip"), /ZIP archive/i],
  ])("rejects invalid EPUB bytes before writing %s", async (name, bytes, error) => {
    const { rawKey } = await seedApiKey();
    const inboxPath = await mkdtemp(join(tmpdir(), "libris-inbox-invalid-"));
    const env = {
      ...AUTH_ENV,
      NODE_ENV: "test",
      PORT: 3000,
      DATABASE_URL: "pglite://",
      REDIS_URL: "redis://localhost:6379",
      LIBRIS_INBOX_PATH: inboxPath,
      LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
      LIBRIS_COVER_FETCH_ALLOWLIST: [],
      API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
      BETTER_AUTH_URL: "",
      MIGRATIONS_PATH: "./migrations",
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
    } as Env;
    const { app } = createApp({
      services: {
        db: db as never,
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
    form.append("file", new File([bytes], name, { type: "application/epub+zip" }));

    const response = await app.request("/api/inbox/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${rawKey}` },
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(error);
    expect(await readdir(inboxPath)).toEqual([]);
    await rm(inboxPath, { recursive: true, force: true });
  });
});

describe("PATCH /api/inbox/:id/rescan", () => {
  it("deletes candidates and resets status atomically in a transaction", async () => {
    const { userId, rawKey } = await seedApiKey();

    // Create a book in "review" status owned by our API key
    const [book] = await db
      .insert(schema.books)
      .values({ status: "review", title: "Test Book", author: "Author", createdBy: userId })
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
      LIBRIS_COVER_FETCH_ALLOWLIST: [],
      API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
      BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
      BETTER_AUTH_URL: "",
      COOKIE_DOMAIN: "",
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
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "review",
        title: "Inbox Book",
        author: "Inbox Author",
        createdBy: userId,
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
      LIBRIS_COVER_FETCH_ALLOWLIST: [],
      API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
      BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
      BETTER_AUTH_URL: "",
      COOKIE_DOMAIN: "",
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
    expect(listedBook.uploader).toEqual({ id: userId, label: "Inbox Test Key" });
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
    expect(detailBody.files[0]).not.toHaveProperty("inboxPath");
    expect(detailBody.uploader).toEqual({ id: userId, label: "Inbox Test Key" });
    expect(detailBody.uploader).not.toHaveProperty("key");
    expect(detailBody.uploader).not.toHaveProperty("keyPrefix");
    expect(detailBody.uploader).not.toHaveProperty("keyHash");
    expect(detailBody.uploader).not.toHaveProperty("isAdmin");
    expect(detailBody.uploader).not.toHaveProperty("lastUsedAt");
  });

  it("forbids another non-admin from reading detail and cover routes", async () => {
    const owner = await seedApiKey();
    const other = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({ status: "review", title: "Private Inbox Book", createdBy: owner.userId })
      .returning({ id: schema.books.id });

    const env = {
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
      COOKIE_DOMAIN: "",
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
    } as Env;
    const { app } = createApp({
      services: {
        db: db as never,
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

    for (const path of [`/api/inbox/${book.id}`, `/api/inbox/${book.id}/cover`]) {
      const response = await app.request(path, {
        headers: { Authorization: `Bearer ${other.rawKey}` },
      });
      expect(response.status).toBe(403);
    }

    const listResponse = await app.request("/api/inbox", {
      headers: { Authorization: `Bearer ${other.rawKey}` },
    });
    expect((await listResponse.json()).data).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: book.id })]),
    );

    const countResponse = await app.request("/api/inbox/count", {
      headers: { Authorization: `Bearer ${other.rawKey}` },
    });
    expect(await countResponse.json()).toEqual({ count: 0 });
  });
});
