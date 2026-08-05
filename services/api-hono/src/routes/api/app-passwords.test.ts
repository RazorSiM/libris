/**
 * App password endpoints.
 *
 * These replace the bespoke /api/auth/keys routes. The credential itself is a
 * Better Auth api key, so most of the behaviour under test is about the
 * boundary this router draws around the plugin: that the plaintext is returned
 * exactly once, that a user only ever sees their own keys, and that one user
 * cannot revoke another's — none of which the plugin enforces for a
 * server-side call.
 */
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import { createTestAuth, createTestDb, seedUser, type TestDb } from "../../db/test-utils.js";
import * as schema from "../../db/schema.js";
import type { Env } from "../../env.js";
import { createMemoryKVStore } from "../../services/kv-store.js";
import { appPasswordRoutes } from "./app-passwords.js";

const TEST_ENV = {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  LIBRIS_COOKIE_SECURE: "0",
} as unknown as Env;

let pglite: PGlite;
let db: TestDb;
let auth: ReturnType<typeof createTestAuth>;
let app: Hono<{ Variables: AppVariables }>;

/** Who the fake middleware will claim to be for the next request. */
let actingUserId: string | undefined;
let actingRole: string | undefined;

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
    // Stands in for authMiddleware: this suite is about the router's own
    // authorization, and driving real credentials through it would only be
    // re-testing middleware/auth.ts.
    c.set("userId", actingUserId);
    c.set("role", actingRole);
    await next();
  });
  app.route("/api/app-passwords", appPasswordRoutes);
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
  await db.delete(schema.apiKeys);
  await db.delete(schema.users);
  actingRole = "user";
});

async function req(path: string, init: Omit<RequestInit, "headers"> = {}) {
  const res = await app.request(`/api/app-passwords${path}`, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  // 204 has no body, which res.json() would choke on.
  const body = res.status === 204 ? {} : ((await res.json()) as Record<string, never>);
  return { status: res.status, body };
}

describe("POST /api/app-passwords", () => {
  it("returns the plaintext key exactly once", async () => {
    actingUserId = await seedUser(db);

    const created = await req("", { method: "POST", body: JSON.stringify({ name: "Kobo" }) });
    expect(created.status).toBe(201);
    expect(created.body.key as unknown as string).toBeTruthy();
    expect(created.body.name).toBe("Kobo");

    // ...and never again: the stored value is a hash, so the list endpoint has
    // nothing to leak even if it wanted to.
    const listed = await req("");
    expect(listed.status).toBe(200);
    const keys = listed.body.keys as unknown as Record<string, unknown>[];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty("key");
  });

  it("rejects an anonymous caller", async () => {
    actingUserId = undefined;
    expect((await req("", { method: "POST", body: JSON.stringify({ name: "X" }) })).status).toBe(
      401,
    );
  });

  it("rejects a missing name", async () => {
    actingUserId = await seedUser(db);
    expect((await req("", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe("GET /api/app-passwords", () => {
  it("lists only the caller's own keys", async () => {
    const mine = await seedUser(db);
    const theirs = await seedUser(db);
    await auth.api.createApiKey({ body: { userId: mine, name: "Mine" } });
    await auth.api.createApiKey({ body: { userId: theirs, name: "Theirs" } });

    actingUserId = mine;
    const { body } = await req("");
    const keys = body.keys as unknown as { name: string }[];
    expect(keys.map((k) => k.name)).toEqual(["Mine"]);
  });
});

describe("DELETE /api/app-passwords/{id}", () => {
  it("revokes the caller's own key", async () => {
    actingUserId = await seedUser(db);
    const created = await auth.api.createApiKey({
      body: { userId: actingUserId, name: "Doomed" },
    });

    expect((await req(`/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  it("refuses to revoke someone else's key, and says 404 rather than 403", async () => {
    // 403 would confirm the id exists, which tells an attacker enumerating ids
    // exactly what they wanted to know. A key you cannot see does not exist.
    const victim = await seedUser(db);
    const created = await auth.api.createApiKey({ body: { userId: victim, name: "Victim" } });

    actingUserId = await seedUser(db);
    expect((await req(`/${created.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await db.select().from(schema.apiKeys)).toHaveLength(1);
  });

  it("404s for an id that does not exist", async () => {
    actingUserId = await seedUser(db);
    expect((await req("/does-not-exist", { method: "DELETE" })).status).toBe(404);
  });
});
