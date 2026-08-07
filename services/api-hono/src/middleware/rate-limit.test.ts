import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import type { Env } from "../env.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import type { KVStore } from "../services/kv-store.js";
import { rateLimitMiddleware, resolveRateLimitTiers } from "./rate-limit.js";

/** Every operation fails, the way the Redis-backed store does when Redis is down. */
function createUnavailableKVStore(): KVStore {
  const fail = () => Promise.reject(new Error("ECONNREFUSED"));
  return {
    getItem: fail,
    setItem: fail,
    increment: fail,
    getKeys: fail,
    removeItem: fail,
    clear: fail,
  } as unknown as KVStore;
}

interface BuildOptions {
  env?: Partial<Env>;
  /** Stands in for Redis being down. */
  storage?: KVStore;
}

/** A minimal stack: the limiter, an echoing handler, and a memory store. */
function buildLimitedApp({ env: overrides = {}, storage: store }: BuildOptions = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const env = {
    NODE_ENV: "production",
    E2E_TEST: "",
    LIBRIS_RATELIMIT_GENERAL_LIMIT: 100,
    LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_AUTH_LIMIT: 2,
    LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 100,
    LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 60,
    ...overrides,
  } as Env;
  const storage = store ?? createMemoryKVStore();
  app.use("*", async (c, next) => {
    c.set("env", env);
    c.set("redisStorage", storage);
    c.set("clientIp", c.req.header("x-test-source") ?? "192.0.2.1");
    await next();
  });
  app.use("*", rateLimitMiddleware);
  app.all("*", (c) => c.json({ ok: true }));
  return { app, env, storage };
}

describe("resolveRateLimitTiers", () => {
  it("stands aside for the whole /api/auth/ prefix", () => {
    // Better Auth limits its own endpoints, and far more tightly than any tier
    // here. Two limiters on one route means two budgets and a 429 that neither
    // one accounts for.
    for (const [path, method] of [
      ["/api/auth/sign-in/email", "POST"],
      ["/api/auth/change-password", "POST"],
      ["/api/auth/get-session", "GET"],
      ["/api/auth/admin/list-users", "GET"],
      ["/api/auth/some/plugin/added/later", "POST"],
    ] as const) {
      expect(resolveRateLimitTiers(path, method), path).toEqual([]);
    }
  });

  it("does not let the /api/auth/ exemption leak onto a sibling path", () => {
    expect(resolveRateLimitTiers("/api/authors", "GET")).toEqual(["general"]);
  });

  it("places OPDS routes in the general tier (browsing, not credential probing)", () => {
    expect(resolveRateLimitTiers("/opds", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/opds/books", "GET")).toEqual(["general"]);
  });

  it("throttles the KoSync credential check, which Better Auth does not cover", () => {
    // KOReader speaks its own protocol on its own prefix, so this is the only
    // credential check left outside Better Auth's reach.
    expect(resolveRateLimitTiers("/kosync/users/auth", "GET")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/users/auth", "POST")).toEqual(["auth"]);
    expect(resolveRateLimitTiers("/kosync/syncs/progress", "PUT")).toEqual(["general"]);
  });

  it("puts credential creation in both the strict and the auth tier", () => {
    // /api/setup is public by necessity and hashes a password before it can
    // 409; /api/app-passwords needs a session but still costs a hash a call.
    expect(resolveRateLimitTiers("/api/setup", "POST")).toEqual(["keyCreation", "auth"]);
    expect(resolveRateLimitTiers("/api/app-passwords", "POST")).toEqual(["keyCreation", "auth"]);
  });

  it("leaves reading and revoking credentials in the general tier", () => {
    // Listing or deleting your own app passwords probes nothing.
    expect(resolveRateLimitTiers("/api/app-passwords", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/app-passwords/abc123", "DELETE")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/setup", "GET")).toEqual(["general"]);
  });

  it("puts ordinary library traffic in the general tier", () => {
    expect(resolveRateLimitTiers("/api/books", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/api/library", "GET")).toEqual(["general"]);
  });

  it("bounds /api/health rather than exempting it", () => {
    // The old exemption was justified by "liveness must remain observable when
    // Redis is unavailable", which the general tier's fail-open already
    // provides (pinned by the store-failure test below). Unbounded, /api/health
    // was an unauthenticated SELECT 1 plus a Redis PING per call, on a path
    // access logging also skips — a flood of it saturated the connection pool
    // silently.
    expect(resolveRateLimitTiers("/api/health", "GET")).toEqual(["general"]);
  });

  it("rate-limits static and unknown paths by default", () => {
    expect(resolveRateLimitTiers("/", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/assets/app.js", "GET")).toEqual(["general"]);
    expect(resolveRateLimitTiers("/future-server-namespace", "POST")).toEqual(["general"]);
  });

  it("limits one sign-in identity across changing source addresses", async () => {
    const { app } = buildLimitedApp();

    const attempt = (source: string) =>
      app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-source": source },
        body: JSON.stringify({ email: "reader@example.com", password: "wrong" }),
      });

    expect((await attempt("192.0.2.1")).status).toBe(200);
    expect((await attempt("192.0.2.2")).status).toBe(200);
    expect((await attempt("192.0.2.3")).status).toBe(429);
  });

  it("stops an unauthenticated /api/health flood", async () => {
    const { app } = buildLimitedApp({ env: { LIBRIS_RATELIMIT_GENERAL_LIMIT: 2 } });

    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(429);
  });

  it("still answers /api/health when the rate-limit store is down", async () => {
    // This is the property the old path-level exemption claimed to protect,
    // and it belongs to the general tier's fail-open, not to the exemption:
    // services/rate-limit.ts allows the request when the store throws for any
    // tier that is not auth/keyCreation. Liveness stays observable either way.
    const { app } = buildLimitedApp({
      env: { LIBRIS_RATELIMIT_GENERAL_LIMIT: 1 },
      storage: createUnavailableKVStore(),
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await app.request("/api/health")).status, `attempt ${attempt}`).toBe(200);
    }
  });

  it("accumulates POST /kosync/users/auth attempts against the username", async () => {
    // The POST form takes the plaintext password and answers 200 + userkey or
    // 401 — the best brute-force oracle in the app. It carries the username in
    // the body, not in x-auth-user, so it used to fall through to the per-IP
    // auth tier alone and a rotating address pool never exhausted a budget.
    const { app } = buildLimitedApp();

    const attempt = (source: string, username: string) =>
      app.request("/kosync/users/auth", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-source": source },
        body: JSON.stringify({ username, password: "guess" }),
      });

    // auth limit is 2. Three different source addresses, one username.
    expect((await attempt("192.0.2.1", "reader")).status).toBe(200);
    expect((await attempt("192.0.2.2", "reader")).status).toBe(200);
    expect((await attempt("192.0.2.3", "reader")).status).toBe(429);
    // A different username still has its own budget from a fresh address.
    expect((await attempt("192.0.2.4", "someone-else")).status).toBe(200);
  });

  it("keeps the GET form bucketed by x-auth-user", async () => {
    const { app } = buildLimitedApp();

    const attempt = (source: string) =>
      app.request("/kosync/users/auth", {
        headers: { "x-auth-user": "reader", "x-auth-key": "digest", "x-test-source": source },
      });

    expect((await attempt("198.51.100.1")).status).toBe(200);
    expect((await attempt("198.51.100.2")).status).toBe(200);
    expect((await attempt("198.51.100.3")).status).toBe(429);
  });

  it("does not throw when a kosync POST body is malformed", async () => {
    const { app } = buildLimitedApp();
    const res = await app.request("/kosync/users/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    // Falls back to the per-IP auth tier: served, not 500.
    expect(res.status).toBe(200);
  });

  it("falls back to IP-only limiting instead of parsing an oversized body", async () => {
    // bodyLimitMiddleware caps every body at 1 MB before this middleware runs,
    // but the limiter refuses to buffer anything large on its own account too.
    // The request must still be served, not thrown out of the limiter.
    const { app } = buildLimitedApp();
    const body = JSON.stringify({ email: "reader@example.com", pad: "x".repeat(20_000) });

    for (const source of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "x-test-source": source,
        },
        body,
      });
      expect(res.status, source).toBe(200);
    }
  });
});
