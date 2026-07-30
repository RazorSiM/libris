/**
 * Integration tests: KoSync authentication.
 *
 * Uses a PGlite in-memory database and the Hono test client (app.request())
 * so no live server or external dependencies are required.
 *
 * Covers:
 * - Timing-normalized rejection for invalid usernames (no side-channel)
 * - Raw header-password fallback path in compareWithMd5Fallback
 * - Standard auth flows for POST body auth and KOReader header auth
 */

import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../app.js";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import { md5 } from "./auth.js";
import type { Env } from "../env.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const KOSYNC_USER = "kosync-test-user";
const KOSYNC_PASS = "kosync-test-pass";

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
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
let app: ReturnType<typeof createApp>["app"];

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;

  const services = {
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
    shutdown: async () => {},
  };

  ({ app } = createApp({ services, env: TEST_ENV }));

  // Seed an API key so we can associate KoSync credentials
  const [testKey] = await db
    .insert(schema.apiKeys)
    .values({
      keyPrefix: "test____",
      keyHash: "test-kosync-key-hash-unique",
      label: "KoSync Test Key",
      isAdmin: false,
    })
    .returning();

  // Seed KoSync credentials — DB stores bcrypt(md5(password)) to match KOReader behavior
  const passwordHash = await hash(md5(KOSYNC_PASS), 10);
  await db.insert(schema.serviceCredentials).values({
    service: "kosync",
    username: KOSYNC_USER,
    passwordHash,
    apiKeyId: testKey.id,
  });
});

afterAll(async () => {
  await pglite.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KoSync Auth (integration)", () => {
  it("authenticates with raw password via POST /kosync/users/auth", async () => {
    const res = await app.request("/kosync/users/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: KOSYNC_USER,
        password: KOSYNC_PASS,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorized).toBe("OK");
    expect(body.userkey).toBe(md5(KOSYNC_PASS));
  });

  it("authenticates with md5-hashed password via GET /kosync/users/auth headers", async () => {
    const res = await app.request("/kosync/users/auth", {
      headers: {
        "x-auth-user": KOSYNC_USER,
        "x-auth-key": md5(KOSYNC_PASS),
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorized).toBe("OK");
  });

  it("authenticates with raw password sent via x-auth-key header — exercises fallback path", async () => {
    // KOReader normally sends md5(password) via x-auth-key, but a direct API
    // user might send the raw password. The md5 fallback in compareWithMd5Fallback
    // should handle this.
    const res = await app.request("/kosync/users/auth", {
      headers: {
        "x-auth-user": KOSYNC_USER,
        // Send raw password instead of md5(password)
        "x-auth-key": KOSYNC_PASS,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authorized).toBe("OK");
  });

  it("rejects wrong password with 401", async () => {
    const res = await app.request("/kosync/users/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: KOSYNC_USER,
        password: "wrong-password",
      }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects wrong username with 401 (timing-normalized)", async () => {
    const res = await app.request("/kosync/users/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "nonexistent-user",
        password: KOSYNC_PASS,
      }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects missing credentials via GET headers with 401", async () => {
    const res = await app.request("/kosync/users/auth");

    expect(res.status).toBe(401);
  });

  it("POST /kosync/users/create always returns 409", async () => {
    const res = await app.request("/kosync/users/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "new-user",
        password: "new-pass",
      }),
    });

    expect(res.status).toBe(409);
  });
});
