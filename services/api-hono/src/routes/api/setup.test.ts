/**
 * First-run bootstrap (libris-5ng.6).
 *
 * A fresh self-hosted install has no accounts and no way in. This is the only
 * public write endpoint in the whole auth surface — everything else is
 * admin-created — so the "only when users is empty" guard is the entire
 * security boundary and gets tested accordingly.
 */
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import { createTestAuth, createTestDb, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { setupRoutes } from "./setup.js";

const TEST_ENV = {
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
} satisfies Env;

let pglite: PGlite;
let db: TestDb;
let auth: ReturnType<typeof createTestAuth>;
let app: Hono<{ Variables: AppVariables }>;

const BODY = {
  email: "first@example.test",
  password: "correct-horse-battery-staple",
  name: "First Admin",
};

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  auth = createTestAuth(db, TEST_ENV);

  app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("env", TEST_ENV);
    c.set("auth", auth);
    c.set("redisStorage", createMemoryKVStore());
    c.set("cacheStorage", createMemoryKVStore());
    await next();
  });
  // No authMiddleware: the route is public by design, and mounting it here
  // would only test route-policy.ts again.
  app.route("/api/setup", setupRoutes);
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json({ error: err.message }, err.status)
      : c.json({ error: String(err) }, 500),
  );
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
  // The bootstrap claim is a 60-second lease, so it outlives a test. A fresh
  // install has no claim; clearing it is what makes each test a fresh install.
  await db.delete(schema.appSettings);
});

async function postSetup(body: unknown = BODY) {
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/setup", () => {
  it("creates the first admin on an empty database", async () => {
    const { status, body } = await postSetup();

    expect(status).toBe(201);
    expect(body.email).toBe(BODY.email);
    expect(body.role).toBe("admin");
    // Never echo the password, hashed or otherwise.
    expect(body).not.toHaveProperty("password");

    const users = await db.select().from(schema.users);
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");
  });

  it("creates a password the new admin can actually sign in with", async () => {
    // The whole point: a bootstrap that produces an account nobody can use is
    // worse than no bootstrap at all.
    await postSetup();

    const signedIn = await auth.api.signInEmail({
      body: { email: BODY.email, password: BODY.password },
    });
    expect(signedIn.user.email).toBe(BODY.email);
  });

  it("refuses once any user exists", async () => {
    expect((await postSetup()).status).toBe(201);

    const { status, body } = await postSetup({ ...BODY, email: "second@example.test" });
    expect(status).toBe(409);
    expect(String(body.error)).toMatch(/already/i);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it("refuses even when the existing user is a plain non-admin", async () => {
    // Guarding on "no admin exists" rather than "no user exists" would let
    // anyone with a normal account mint themselves a second, admin one.
    await auth.api.createUser({
      body: { email: "plain@example.test", password: BODY.password, name: "Plain", role: "user" },
    });

    expect((await postSetup()).status).toBe(409);
  });

  it("cannot be raced into creating two admins", async () => {
    const results = await Promise.allSettled([
      postSetup({ ...BODY, email: "a@example.test" }),
      postSetup({ ...BODY, email: "b@example.test" }),
      postSetup({ ...BODY, email: "c@example.test" }),
    ]);

    const created = results.filter(
      (r) => r.status === "fulfilled" && r.value.status === 201,
    ).length;
    expect(created).toBe(1);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it("rejects a malformed body", async () => {
    expect((await postSetup({ email: "not-an-email", password: "x" })).status).toBe(400);
  });
});

describe("GET /api/setup", () => {
  // The login page has to know whether to offer "sign in" or "create the first
  // admin", and it is unauthenticated when it asks — there is no account yet.
  // Deliberately a bare boolean: anything richer would be an unauthenticated
  // window into who exists on this server.
  async function getSetup() {
    const res = await app.request("/api/setup");
    return { status: res.status, body: (await res.json()) as { required: boolean } };
  }

  it("reports setup as required on an empty database", async () => {
    expect(await getSetup()).toEqual({ status: 200, body: { required: true } });
  });

  it("reports setup as done once any user exists", async () => {
    await postSetup();
    expect(await getSetup()).toEqual({ status: 200, body: { required: false } });
  });

  it("leaks nothing about the users themselves", async () => {
    await postSetup();
    const res = await app.request("/api/setup");
    expect(Object.keys((await res.json()) as object)).toEqual(["required"]);
  });
});
