/**
 * Integration tests: KoSync authentication.
 *
 * KOReader sends md5(password) as x-auth-key, so the md5 digest IS the bearer
 * secret — the plaintext never reaches the server. The old implementation
 * stored bcrypt(md5(password)) and accepted EITHER the digest or the plaintext,
 * which is two valid secrets where there should be one. The suite asserts the
 * plaintext is rejected, which is the point of that change.
 *
 * What the digest is hashed WITH is a separate question, settled separately:
 * the wire value is md5 of a human-chosen password, so the stored form is a
 * salted HMAC under a pepper derived from API_SECRET_KEY rather than the bare
 * sha256 it used to be.
 */

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createApp } from "../app.js";
import { createTestAuth, createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import { md5 } from "./auth.js";
import { hashKosyncSecret, legacyKosyncSecretHash, verifyKosyncSecret } from "./kosync-auth.js";
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

/** The stored form of a wire secret, under this suite's server secret. */
const stored = (wireValue: string) => hashKosyncSecret(wireValue, TEST_ENV.API_SECRET_KEY);

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

  // The stored value is a salted, peppered MAC of exactly what KOReader puts
  // on the wire.
  await db.insert(schema.kosyncCredentials).values({
    userId: owner,
    username: KOSYNC_USER,
    secretHash: stored(md5(KOSYNC_PASS)),
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
      secretHash: stored(md5("other-pass")),
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

  /**
   * KoSync is the one credential path that never touches Better Auth, so
   * nothing on it ever consulted the account's state: a banned user's
   * KOReader kept reading and writing progress, and /users/auth kept handing
   * out a userkey they could pair a NEW device with.
   */
  describe("banned accounts", () => {
    async function seedKosyncUser(
      username: string,
      password: string,
      ban: { banned: boolean; banExpires: Date | null },
    ): Promise<void> {
      const userId = await seedUser(db, { name: username });
      await db.update(schema.users).set(ban).where(eq(schema.users.id, userId));
      await db.insert(schema.kosyncCredentials).values({
        userId,
        username,
        secretHash: stored(md5(password)),
      });
    }

    it("refuses a banned user's credentials with the same 401 a wrong password gets", async () => {
      await seedKosyncUser("banned-kosync", "banned-pass", { banned: true, banExpires: null });

      const res = await app.request("/kosync/users/auth", {
        headers: { "x-auth-user": "banned-kosync", "x-auth-key": md5("banned-pass") },
      });

      expect(res.status).toBe(401);
      // Indistinguishable from the wrong-password refusal: saying "banned"
      // would confirm both the username and the credential.
      expect(await res.json()).toEqual(
        await (
          await app.request("/kosync/users/auth", {
            headers: { "x-auth-user": KOSYNC_USER, "x-auth-key": md5("nope") },
          })
        ).json(),
      );
    });

    it("refuses a banned user's progress sync too, not just the auth probe", async () => {
      await seedKosyncUser("banned-sync", "banned-pass", { banned: true, banExpires: null });

      const res = await app.request("/kosync/syncs/progress?document=abc", {
        headers: { "x-auth-user": "banned-sync", "x-auth-key": md5("banned-pass") },
      });

      expect(res.status).toBe(401);
    });

    it("lets a user back in once the ban has expired", async () => {
      await seedKosyncUser("expired-ban-kosync", "expired-pass", {
        banned: true,
        banExpires: new Date(Date.now() - 60_000),
      });

      const res = await app.request("/kosync/users/auth", {
        headers: { "x-auth-user": "expired-ban-kosync", "x-auth-key": md5("expired-pass") },
      });

      expect(res.status).toBe(200);
    });
  });

  it("POST /kosync/users/create refuses a bodyless request too", async () => {
    // KOReader is not the only thing that reaches a public endpoint. Reading a
    // body that is never used turned an empty POST into a 500.
    const res = await app.request("/kosync/users/create", { method: "POST" });

    expect(res.status).toBe(409);
  });
});

/**
 * The stored secret used to be a bare, unsalted sha256 of the wire value. The
 * wire value is md5 of a password a human chose and typed into
 * KOReader, and md5 adds no entropy, so a leaked `kosync_credentials` was one
 * GPU wordlist pass away from every plaintext in the table at once — the same
 * plaintext people reuse for the account whose hash in `accounts.password` is
 * properly protected.
 *
 * The answer is not a work factor: this is verified on an unauthenticated
 * endpoint KOReader hits on every progress read and write. It is to take the
 * secret out of the database — a pepper the database does not contain — plus a
 * per-row salt so nothing amortises across rows.
 */
describe("KoSync secret storage", () => {
  const SERVER_SECRET = TEST_ENV.API_SECRET_KEY;
  const OTHER_SECRET = "a-completely-different-server-secret-value!!";
  const WIRE = md5("a-perfectly-ordinary-password");

  it("stores neither the wire value nor any unkeyed digest of it", async () => {
    const record = stored(WIRE);

    // The old scheme was reproducible by anyone holding the row: this is the
    // exact assertion that fails against it.
    expect(record).not.toBe(legacyKosyncSecretHash(WIRE));
    expect(record).not.toContain(WIRE);
    expect(record).toMatch(/^v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  });

  it("salts per row, so two users who chose the same password differ", () => {
    expect(stored(WIRE)).not.toBe(stored(WIRE));
    // ...and both still verify.
    expect(verifyKosyncSecret(WIRE, stored(WIRE), SERVER_SECRET).ok).toBe(true);
  });

  it("is worthless without the server secret", () => {
    const record = hashKosyncSecret(WIRE, SERVER_SECRET);

    expect(verifyKosyncSecret(WIRE, record, SERVER_SECRET).ok).toBe(true);
    // A database-only disclosure: the attacker has the row and the candidate
    // password, and still cannot confirm it.
    expect(verifyKosyncSecret(WIRE, record, OTHER_SECRET).ok).toBe(false);
  });

  it("rejects the wrong wire value, and a malformed record", () => {
    expect(verifyKosyncSecret(md5("nope"), stored(WIRE), SERVER_SECRET).ok).toBe(false);
    expect(verifyKosyncSecret(WIRE, "v1$deadbeef", SERVER_SECRET).ok).toBe(false);
    expect(verifyKosyncSecret(WIRE, "v1$$", SERVER_SECRET).ok).toBe(false);
    expect(verifyKosyncSecret(WIRE, "", SERVER_SECRET).ok).toBe(false);
    // An empty stored value must not match an empty candidate digest either.
    expect(verifyKosyncSecret("", "", SERVER_SECRET).ok).toBe(false);
  });

  it("verifies a pre-v1 row and flags it for rewriting", () => {
    const legacy = legacyKosyncSecretHash(WIRE);

    expect(verifyKosyncSecret(WIRE, legacy, SERVER_SECRET)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(verifyKosyncSecret(md5("nope"), legacy, SERVER_SECRET)).toEqual({
      ok: false,
      needsRehash: false,
    });
    // A v1 row is never re-minted, so the upgrade is a one-off per row.
    expect(verifyKosyncSecret(WIRE, stored(WIRE), SERVER_SECRET).needsRehash).toBe(false);
  });
});

/**
 * The upgrade path an install that is already syncing takes. Nobody re-enters
 * a credential: the first request their KOReader makes after the deploy
 * verifies against the old format and rewrites the row in the new one.
 */
describe("KoSync legacy credential upgrade", () => {
  it("authenticates a pre-v1 row, rewrites it, and keeps working after", async () => {
    const userId = await seedUser(db, { name: "Legacy Reader" });
    await db.insert(schema.kosyncCredentials).values({
      userId,
      username: "legacy-reader",
      // Exactly what a row written before the peppered-HMAC change looks like.
      secretHash: legacyKosyncSecretHash(md5("legacy-password")),
    });

    const authed = await app.request("/kosync/users/auth", {
      headers: { "x-auth-user": "legacy-reader", "x-auth-key": md5("legacy-password") },
    });
    expect(authed.status).toBe(200);

    const [row] = await db
      .select({ secretHash: schema.kosyncCredentials.secretHash })
      .from(schema.kosyncCredentials)
      .where(eq(schema.kosyncCredentials.userId, userId));

    // The bare digest is gone from the table, which is the whole point: the
    // rewrite happens without the user doing anything.
    expect(row!.secretHash).not.toBe(legacyKosyncSecretHash(md5("legacy-password")));
    expect(row!.secretHash).toMatch(/^v1\$/);

    // And the same device credential still authenticates against the new row.
    const again = await app.request("/kosync/users/auth", {
      headers: { "x-auth-user": "legacy-reader", "x-auth-key": md5("legacy-password") },
    });
    expect(again.status).toBe(200);
  });

  it("does not upgrade — or authenticate — a banned user's legacy row", async () => {
    const userId = await seedUser(db, { name: "Banned Legacy Reader" });
    await db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, userId));
    const legacy = legacyKosyncSecretHash(md5("banned-legacy-password"));
    await db.insert(schema.kosyncCredentials).values({
      userId,
      username: "banned-legacy-reader",
      secretHash: legacy,
    });

    const res = await app.request("/kosync/users/auth", {
      headers: {
        "x-auth-user": "banned-legacy-reader",
        "x-auth-key": md5("banned-legacy-password"),
      },
    });
    expect(res.status).toBe(401);

    const [row] = await db
      .select({ secretHash: schema.kosyncCredentials.secretHash })
      .from(schema.kosyncCredentials)
      .where(eq(schema.kosyncCredentials.userId, userId));
    expect(row!.secretHash).toBe(legacy);
  });
});
