import { createMemoryKVStore } from "../../services/kv-store.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createApp } from "../../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";

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

async function seedApiKey() {
  // A real Better Auth app password: the key column holds a hash the plugin
  // computes, so a hand-written api_keys row cannot authenticate.
  return await seedAppPassword(createTestAuth(db, TEST_ENV), db, { name: "Books Test Key" });
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

describe("POST /api/books/{id}/approve", () => {
  it("rejects a stale review-to-organized transition and does not enqueue organize", async () => {
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({
        status: "review",
        title: "Draft title",
        createdBy: userId,
      })
      .returning({ id: schema.books.id });

    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book.id,
      source: "hardcover",
      normalized: { title: "Approved title" },
      confidence: "0.95",
    });

    let organizeEnqueues = 0;
    let flippedStatus = false;
    const runTransaction = db.transaction.bind(db);

    const proxiedDb = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callback: (tx: any) => Promise<unknown>,
            config?: unknown,
          ): Promise<unknown> => {
            if (!flippedStatus) {
              flippedStatus = true;
              await db
                .update(schema.books)
                .set({ status: "organized", updatedAt: new Date() })
                .where(eq(schema.books.id, book.id));
            }

            return runTransaction(callback, config as never);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    });

    const { app } = createApp({
      services: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: proxiedDb as any,
        queues: {
          bookDetected: { add: async () => ({}) },
          bookParseFile: { add: async () => ({}) },
          bookFetchMetadata: { add: async () => ({}) },
          bookOrganize: {
            add: async () => {
              organizeEnqueues += 1;
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

    const response = await app.request(`/api/books/${book.id}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          title: {
            source: "hardcover",
            value: "Approved title",
          },
        },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Book is in 'organized' status, expected 'review'",
    });
    expect(organizeEnqueues).toBe(0);

    const [storedBook] = await db
      .select({ status: schema.books.status, title: schema.books.title })
      .from(schema.books)
      .where(eq(schema.books.id, book.id));

    expect(storedBook).toEqual({ status: "organized", title: "Draft title" });
  });

  it("normalizes the language when approving a reviewed book", async () => {
    const { userId, rawKey } = await seedApiKey();
    const [book] = await db
      .insert(schema.books)
      .values({ status: "review", title: "Draft", createdBy: userId })
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
        cacheStorage: createMemoryKVStore(),
        auth: createTestAuth(db, TEST_ENV),
        shutdown: async () => {},
      },
      env: TEST_ENV,
    });

    const response = await app.request(`/api/books/${book.id}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          title: { source: "manual", value: "Approved" },
          // A non-canonical value must be normalized to its ISO 639-1 code.
          language: { source: "manual", value: "English" },
        },
      }),
    });

    expect(response.status).toBe(200);

    const [stored] = await db
      .select({ language: schema.books.language, status: schema.books.status })
      .from(schema.books)
      .where(eq(schema.books.id, book.id));

    expect(stored).toEqual({ language: "en", status: "organized" });
  });
});
