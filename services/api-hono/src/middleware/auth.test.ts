/**
 * authMiddleware against the Better Auth session (libris-5ng.8).
 *
 * The bet the epic is built on: because `enableSessionForAPIKeys` is on, a
 * single `auth.api.getSession()` resolves BOTH a cookie session and an app
 * password. These tests are what proves it — if they pass, the old five-branch
 * policy switch really was redundant.
 *
 * Deliberately built on a bare Hono app rather than createApp(): this is about
 * the middleware and the policy table, and the full app drags in Redis, queues
 * and static file serving that have nothing to do with either.
 */
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import { createTestAuth, createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import { isAdmin } from "../shared/auth.js";
import { authMiddleware } from "./auth.js";

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

/** Whatever the middleware decided, as JSON. */
interface Probe {
  userId?: string;
  userName?: string;
  role?: string;
  isAdmin: boolean;
}

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
  app.use("*", authMiddleware);
  // Mirrors app.ts's handler, headers and all — a handler that rebuilt the
  // response from scratch would silently drop WWW-Authenticate and let the
  // OPDS challenge test pass here while failing in production.
  app.onError((err, c) => {
    if (!(err instanceof HTTPException)) return c.json({ error: String(err) }, 500);
    const headers: Record<string, string> = {};
    err.getResponse().headers.forEach((v, k) => {
      headers[k] = v;
    });
    return c.json({ error: err.message }, { status: err.status, headers });
  });

  const probe = (c: Context<{ Variables: AppVariables }>) =>
    c.json({
      userId: c.get("userId"),
      userName: c.get("userName"),
      role: c.get("role"),
      // Derived from role, not a context variable of its own (libris-5ng.9).
      isAdmin: isAdmin(c),
    });

  // One route per policy in the table, so the policies are exercised as
  // resolvePolicy() actually assigns them rather than as this file imagines.
  app.get("/api/books", probe); // api-key
  app.get("/api/jobs", probe); // admin
  app.get("/api/health", probe); // optional
  app.get("/opds", probe); // opds
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.delete(schema.apiKeys);
  await db.delete(schema.sessions);
  await db.delete(schema.accounts);
  await db.delete(schema.users);
});

// ── fixtures ────────────────────────────────────────────────────────

const PASSWORD = "correct-horse-battery-staple";

/**
 * Sign a user up and return the cookie a browser would send back.
 *
 * The role is applied BEFORE signing in, deliberately. Sessions live in
 * secondaryStorage as a {session, user} snapshot, so a role written straight to
 * the database afterwards would not appear in an already-issued session — see
 * the "role change" test below, which pins that behaviour down.
 */
async function signUp(
  email: string,
  role: "user" | "admin" = "user",
): Promise<{ userId: string; cookie: string }> {
  // createUser, not signUpEmail: self-registration is disabled outright
  // (emailAndPassword.disableSignUp), so this is the only way accounts exist.
  const created = await auth.api.createUser({
    body: { email, password: PASSWORD, name: email.split("@")[0], role },
  });
  return { userId: created.user.id, cookie: await signIn(email) };
}

/** A fresh cookie for an existing user. */
async function signIn(email: string): Promise<string> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return headers.getSetCookie().join("; ");
}

/**
 * A signed-in admin, for the admin plugin's own endpoints — setRole and banUser
 * both require an admin session rather than accepting a bare server-side call.
 */
async function actingAdmin(): Promise<{ headers: Headers }> {
  const { cookie } = await signUp("acting-admin@example.test", "admin");
  return { headers: new Headers({ cookie }) };
}

/** Mint an app password for a user, server-side (no session needed). */
async function createAppPassword(userId: string, name = "Kobo"): Promise<string> {
  const created = await auth.api.createApiKey({ body: { userId, name } });
  return created.key;
}

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers });
  return { status: res.status, body: (await res.json()) as Probe & { error?: string } };
}

/** The Authorization value an OPDS reader sends. */
function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

// ── the single lookup ───────────────────────────────────────────────

describe("authMiddleware", () => {
  it("resolves a cookie session", async () => {
    const { userId, cookie } = await signUp("cookie@example.test");

    const { status, body } = await get("/api/books", { cookie });
    expect(status).toBe(200);
    expect(body.userId).toBe(userId);
    expect(body.userName).toBe("cookie");
    expect(body.role).toBe("user");
    expect(body.isAdmin).toBe(false);
  });

  it("resolves an app password through the very same call", async () => {
    // This is the collapse the epic is built on: no api-key branch, no bcrypt
    // prefix scan, no cache — the key arrives as a session.
    const { userId } = await signUp("key@example.test");
    const key = await createAppPassword(userId);

    const { status, body } = await get("/api/books", { "x-api-key": key });
    expect(status).toBe(200);
    expect(body.userId).toBe(userId);
  });

  it("rejects an unauthenticated request to an api-key route", async () => {
    const { status, body } = await get("/api/books");
    expect(status).toBe(401);
    expect(body.error).toBe("Authentication required");
  });

  it("rejects a bogus app password", async () => {
    const { status } = await get("/api/books", { "x-api-key": "not-a-real-key" });
    expect(status).toBe(401);
  });

  it("allows an anonymous request to an optional route, with no identity set", async () => {
    const { status, body } = await get("/api/health");
    expect(status).toBe(200);
    expect(body.userId).toBeUndefined();
    expect(body.isAdmin).toBe(false);
  });

  it("enriches an optional route when a credential is present", async () => {
    const { userId, cookie } = await signUp("optional@example.test");
    const { body } = await get("/api/health", { cookie });
    expect(body.userId).toBe(userId);
  });
});

// ── authorization ───────────────────────────────────────────────────

describe("authMiddleware admin gating", () => {
  it("refuses an admin route to a plain user", async () => {
    const { cookie } = await signUp("plain@example.test");
    const { status, body } = await get("/api/jobs", { cookie });
    expect(status).toBe(403);
    expect(body.error).toBe("Admin access required");
  });

  it("admits an admin", async () => {
    const { cookie } = await signUp("boss@example.test", "admin");
    const { status, body } = await get("/api/jobs", { cookie });
    expect(status).toBe(200);
    expect(body.role).toBe("admin");
    expect(body.isAdmin).toBe(true);
  });

  it("carries the owner's role onto their app password", async () => {
    // A key acts as the person who minted it, so an admin's key is admin.
    // That is exactly the blast radius libris-5ng.28 exists to narrow.
    const { userId } = await signUp("boss2@example.test", "admin");
    const key = await createAppPassword(userId);

    const { status, body } = await get("/api/jobs", { "x-api-key": key });
    expect(status).toBe(200);
    expect(body.isAdmin).toBe(true);
  });
});

// ── no cache window ─────────────────────────────────────────────────

describe("authMiddleware revocation", () => {
  it("stops accepting a revoked app password immediately", async () => {
    // The old middleware cached auth results for five minutes behind a manual
    // clearAuthCaches() invariant. Nothing caches now, so revocation is instant.
    const { userId } = await signUp("revoke@example.test");
    const key = await createAppPassword(userId);
    expect((await get("/api/books", { "x-api-key": key })).status).toBe(200);

    await db.delete(schema.apiKeys);

    expect((await get("/api/books", { "x-api-key": key })).status).toBe(401);
  });

  it("reflects a promotion made through the admin plugin", async () => {
    const { userId, cookie } = await signUp("promoted@example.test");
    expect((await get("/api/jobs", { cookie })).status).toBe(403);

    await auth.api.setRole({ ...(await actingAdmin()), body: { userId, role: "admin" } });

    expect((await get("/api/jobs", { cookie })).status).toBe(200);
  });

  it("does NOT see a role written straight to the database", async () => {
    // Not a bug, but a sharp edge worth pinning down. Sessions live in
    // secondaryStorage as a {session, user} snapshot taken at sign-in, so
    // privilege changes have to go through Better Auth's own APIs — which
    // refresh or revoke the affected sessions — rather than through a bare
    // UPDATE. Admin user management (libris-5ng.20) must use auth.api.*.
    const { userId, cookie } = await signUp("sneaky@example.test");
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, userId));

    expect((await get("/api/jobs", { cookie })).status).toBe(403);
    // ...and is picked up on the next sign-in, since that takes a fresh snapshot.
    expect((await get("/api/jobs", { cookie: await signIn("sneaky@example.test") })).status).toBe(
      200,
    );
  });

  it("rejects a banned user", async () => {
    const { userId, cookie } = await signUp("banned@example.test");
    expect((await get("/api/books", { cookie })).status).toBe(200);

    await auth.api.banUser({ ...(await actingAdmin()), body: { userId } });

    expect((await get("/api/books", { cookie })).status).toBe(401);
  });
});

// ── the policy table still applies ──────────────────────────────────

describe("authMiddleware policies", () => {
  it("stands aside for Better Auth's own endpoints", async () => {
    // "skip" for the whole /api/auth/ prefix — if the middleware tried to
    // authenticate sign-in, nobody could ever sign in.
    await signUp("via-handler@example.test");

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "via-handler@example.test", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
  });

  it("keeps self-registration closed", async () => {
    // A locked decision for this epic: accounts are admin-created. The handler
    // catch-all in app.ts would otherwise expose sign-up to anyone.
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "stranger@example.test",
        password: PASSWORD,
        name: "Stranger",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ── how the key arrives ─────────────────────────────────────────────

describe("app passwords over Authorization", () => {
  it("accepts a Bearer key, which is what Bruno, curl and cron send", async () => {
    // libris-5ng.13. The plugin only reads x-api-key by default; every existing
    // consumer of a Libris key sends Bearer, so dropping it would break them
    // all silently on deploy.
    const { userId } = await signUp("bearer@example.test");
    const key = await createAppPassword(userId, "Bruno");

    const { status, body } = await get("/api/books", { authorization: `Bearer ${key}` });
    expect(status).toBe(200);
    expect(body.userId).toBe(userId);
  });

  it("accepts a Basic password, which is all an OPDS reader can send", async () => {
    // libris-5ng.12. KOReader, Moon+, Thorium and Panels speak Basic and
    // nothing else. The username is informational — the app password in the
    // password field is the credential.
    const { userId } = await signUp("opds@example.test");
    const key = await createAppPassword(userId, "KOReader");

    const { status, body } = await get("/opds", { authorization: basic("opds", key) });
    expect(status).toBe(200);
    expect(body.userId).toBe(userId);
  });

  it("accepts a Basic password on a normal API route too", async () => {
    // One credential, one namespace: a reader that follows an acquisition link
    // to /api/... must not suddenly be a stranger.
    const { userId } = await signUp("opds2@example.test");
    const key = await createAppPassword(userId, "Panels");

    const { status, body } = await get("/api/books", { authorization: basic("anything", key) });
    expect(status).toBe(200);
    expect(body.userId).toBe(userId);
  });

  it("rejects a key sent as the Basic USERNAME", async () => {
    // The old extractKey accepted this form. It is deliberately gone: it makes
    // the same string a secret in one position and a public identifier in the
    // other, and anything relying on it moves to Bearer.
    const { userId } = await signUp("legacy@example.test");
    const key = await createAppPassword(userId, "Legacy");

    expect((await get("/api/books", { authorization: basic(key, "") })).status).toBe(401);
  });

  it("still accepts the plugin's own x-api-key header", async () => {
    const { userId } = await signUp("xapikey@example.test");
    const key = await createAppPassword(userId, "Direct");

    expect((await get("/api/books", { "x-api-key": key })).status).toBe(200);
    expect((await get("/api/books", { "x-api-key": key })).body.userId).toBe(userId);
  });

  it("ignores a malformed Authorization header instead of failing loudly", async () => {
    // Garbage in the header is just an absent credential; a 500 here would turn
    // a client bug into an outage-shaped alert.
    for (const authorization of ["Basic", "Basic !!!not-base64!!!", "Bearer", "Digest xyz"]) {
      expect((await get("/api/books", { authorization })).status).toBe(401);
    }
  });
});

describe("OPDS 401s", () => {
  it("carries WWW-Authenticate Basic so readers prompt for credentials", async () => {
    // Without this header an OPDS reader shows an error instead of a login box,
    // which reads to the user as "Libris is broken".
    const res = await app.request("/opds");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm=/i);
  });

  it("does not send WWW-Authenticate on a normal API route", async () => {
    // A browser fetch that gets this header pops the native Basic dialog over
    // the SPA, which is the wrong way to ask someone to sign in.
    const res = await app.request("/api/books");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

describe("app password rate limiting", () => {
  it("survives far more than the plugin's default 10-requests-per-day budget", async () => {
    // The apiKey plugin defaults to 10 requests per DAY per key. Opening an
    // OPDS catalog spends that before the reader has drawn anything, and the
    // rejection arrives as a 401 — indistinguishable, from the user's side,
    // from a wrong password. lib/auth.ts overrides it to 600/minute; this is
    // the assertion that notices if that override is ever dropped.
    const { userId } = await signUp("chatty@example.test");
    const key = await createAppPassword(userId, "KOReader");

    for (let i = 0; i < 25; i++) {
      const { status } = await get("/api/books", { "x-api-key": key });
      expect(status, `request ${i + 1} of 25`).toBe(200);
    }
  });
});
