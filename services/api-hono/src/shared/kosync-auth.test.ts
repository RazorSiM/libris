/**
 * Integration tests: KoSync authentication.
 *
 * KOReader sends md5(password) as x-auth-key, so the md5 digest IS the bearer
 * secret — the plaintext never reaches the server. The old implementation
 * stored bcrypt(md5(password)) and accepted EITHER the digest or the plaintext,
 * which is two valid secrets where there should be one. The suite now asserts
 * the plaintext is rejected, which is the point of the change.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../app.js";
import { createTestAuth, createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import { md5 } from "./auth.js";
import { hashKosyncSecret } from "./kosync-auth.js";
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
    auth: createTestAuth(db, TEST_ENV),
    shutdown: async () => {},
  };

  ({ app } = createApp({ services, env: TEST_ENV }));

  const owner = await seedUser(db, { name: "KoSync Reader" });

  // The stored value is sha256 of exactly what KOReader puts on the wire.
  await db.insert(schema.kosyncCredentials).values({
    userId: owner,
    username: KOSYNC_USER,
    secretHash: hashKosyncSecret(md5(KOSYNC_PASS)),
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

  it("rejects the raw plaintext sent via x-auth-key", async () => {
    // The old compareWithMd5Fallback accepted this, which meant the account had
    // two valid secrets: the digest AND the plaintext it was derived from. Only
    // the value KOReader actually sends authenticates now.
    const res = await app.request("/kosync/users/auth", {
      headers: {
        "x-auth-user": KOSYNC_USER,
        "x-auth-key": KOSYNC_PASS,
      },
    });

    expect(res.status).toBe(401);
  });

  it("rejects a digest that belongs to a different username", async () => {
    // Guards against a lookup that verifies the secret without binding it to
    // the username it was issued for.
    const other = await seedUser(db, { name: "Other Reader" });
    await db.insert(schema.kosyncCredentials).values({
      userId: other,
      username: "other-kosync-user",
      secretHash: hashKosyncSecret(md5("other-pass")),
    });

    const res = await app.request("/kosync/users/auth", {
      headers: { "x-auth-user": KOSYNC_USER, "x-auth-key": md5("other-pass") },
    });

    expect(res.status).toBe(401);
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

  /**
   * KOReader offers a "Register" button that posts here. Libris accounts are
   * admin-created, so this is a second way in that must not work — and what
   * matters is that nothing is written, not merely that the status is 409.
   *
   * 409 rather than 404: KOReader surfaces the message, so the user reads
   * "set your credentials in the dashboard" instead of a bare failure. Hiding
   * the route would buy nothing — /users/auth already announces that this is a
   * KoSync server, and no credential is accepted here either way.
   */
  it("POST /kosync/users/create refuses, and creates nothing", async () => {
    const usersBefore = await db.select().from(schema.users);
    const credsBefore = await db.select().from(schema.kosyncCredentials);

    const res = await app.request("/kosync/users/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "new-user", password: "new-pass" }),
    });

    expect(res.status).toBe(409);
    expect(await db.select().from(schema.users)).toHaveLength(usersBefore.length);
    expect(await db.select().from(schema.kosyncCredentials)).toHaveLength(credsBefore.length);

    // And the credential it tried to register does not authenticate.
    const authRes = await app.request("/kosync/users/auth", {
      headers: { "x-auth-user": "new-user", "x-auth-key": md5("new-pass") },
    });
    expect(authRes.status).toBe(401);
  });

  it("POST /kosync/users/create refuses a bodyless request too", async () => {
    // KOReader is not the only thing that reaches a public endpoint. Reading a
    // body that is never used turned an empty POST into a 500.
    const res = await app.request("/kosync/users/create", { method: "POST" });

    expect(res.status).toBe(409);
  });
});
