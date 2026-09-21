import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import type { Env } from "../env.js";
import { createMemoryKVStore } from "../services/kv-store.js";
import type { KVStore } from "../services/kv-store.js";
import { bodyLimitMiddleware } from "./body-limit.js";
import { rateLimitMiddleware, resolveRateLimitTiers } from "./rate-limit.js";

/** Every operation fails, the way the Redis-backed store does when Redis is down. */
function createUnavailableKVStore(): KVStore {
  const fail = () => Promise.reject(new Error("ECONNREFUSED"));
  return {
    getItem: fail,
    setItem: fail,
    increment: fail,
    peek: fail,
    getKeys: fail,
    removeItem: fail,
    clear: fail,
  } as unknown as KVStore;
}

interface BuildOptions {
  env?: Partial<Env>;
  /** Stands in for Redis being down. */
  storage?: KVStore;
  /** Replaces the echoing handler, for tests that need real 401s. */
  handler?: (c: Context<{ Variables: AppVariables }>) => Response | Promise<Response>;
}

/** A minimal stack: the limiter, an echoing handler, and a memory store. */
function buildLimitedApp({ env: overrides = {}, storage: store, handler }: BuildOptions = {}) {
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
  app.all("*", handler ?? ((c) => c.json({ ok: true })));
  return { app, env, storage };
}

/** The real shape of a KoSync route: 401 unless the secret matches. */
function kosyncSecretHandler(state: { checks: number }) {
  return (c: Context<{ Variables: AppVariables }>) => {
    state.checks += 1;
    if (c.req.header("x-auth-key") !== "good") {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    return c.json({ ok: true });
  };
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

  it("buckets POST /kosync/users/auth by the body username, not the header", async () => {
    // The bypass this closes: the limiter preferred x-auth-user while the
    // handler verified body.username, so an attacker rotating the header (and
    // the source address) got a fresh budget for every guess against one
    // victim. The header is not consulted on POST at all now.
    const { app } = buildLimitedApp();

    const attempt = (source: string, headerUser: string) =>
      app.request("/kosync/users/auth", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-user": headerUser,
          "x-test-source": source,
        },
        body: JSON.stringify({ username: "reader", password: "guess" }),
      });

    expect((await attempt("192.0.2.1", "rotating-1")).status).toBe(200);
    expect((await attempt("192.0.2.2", "rotating-2")).status).toBe(200);
    expect((await attempt("192.0.2.3", "rotating-3")).status).toBe(429);
  });

  it("does not let a header disagree with the body to reset the POST budget", async () => {
    // Same defect, observed from the other side: rotate the header, keep the
    // body. The third attempt must be refused even though each header value is
    // new.
    const { app } = buildLimitedApp();

    const attempt = (headerUser: string) =>
      app.request("/kosync/users/auth", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user": headerUser },
        body: JSON.stringify({ username: "reader", password: "guess" }),
      });

    expect((await attempt("header-a")).status).toBe(200);
    expect((await attempt("header-b")).status).toBe(200);
    expect((await attempt("header-c")).status).toBe(429);
  });

  describe("failure-only budget on progress routes", () => {
    const progress = (source: string, key: string, user = "reader") =>
      new Request("http://localhost/kosync/syncs/progress", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-auth-user": user,
          "x-auth-key": key,
          "x-test-source": source,
        },
        body: JSON.stringify({ document: "doc", progress: "1", percentage: 0.1, device: "dev" }),
      });

    it("throttles repeated wrong credentials across rotating source addresses", async () => {
      const state = { checks: 0 };
      const { app } = buildLimitedApp({ handler: kosyncSecretHandler(state) });

      // auth limit is 2 failures. Three sources, one victim credential.
      expect((await app.request(progress("192.0.2.1", "wrong-1"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.2", "wrong-2"))).status).toBe(401);

      const blocked = await app.request(progress("192.0.2.3", "wrong-3"));
      expect(blocked.status).toBe(429);
      // The third attempt never reached the credential check.
      expect(state.checks).toBe(2);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
    });

    it("does not spend budget on successful syncs", async () => {
      // The whole point of failure-only: a device syncing every few seconds
      // must not lock itself out after 30 requests.
      const state = { checks: 0 };
      const { app } = buildLimitedApp({ handler: kosyncSecretHandler(state) });

      for (let i = 0; i < 10; i += 1) {
        expect((await app.request(progress("192.0.2.9", "good"))).status, `sync ${i}`).toBe(200);
      }
      expect(state.checks).toBe(10);
    });

    it("forgets recorded failures after a successful check", async () => {
      const state = { checks: 0 };
      const { app } = buildLimitedApp({ handler: kosyncSecretHandler(state) });

      expect((await app.request(progress("192.0.2.1", "wrong"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.2", "good"))).status).toBe(200);
      // The success cleared the one failure, so two more are still allowed.
      expect((await app.request(progress("192.0.2.3", "wrong"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.4", "wrong"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.5", "wrong"))).status).toBe(429);
    });

    it("keeps one credential's failures off another's budget", async () => {
      const state = { checks: 0 };
      const { app } = buildLimitedApp({ handler: kosyncSecretHandler(state) });

      expect((await app.request(progress("192.0.2.1", "wrong", "victim"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.2", "wrong", "victim"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.3", "wrong", "bystander"))).status).toBe(401);
      expect((await app.request(progress("192.0.2.4", "wrong", "victim"))).status).toBe(429);
    });

    it("leaves headerless progress requests to the general tier", async () => {
      // No username means nothing was verified and nothing to guess.
      const state = { checks: 0 };
      const { app } = buildLimitedApp({ handler: kosyncSecretHandler(state) });
      const res = await app.request("/kosync/syncs/progress", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: "doc" }),
      });
      expect(res.status).toBe(401);
      expect(state.checks).toBe(1);
    });
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

  it("refuses an oversized sign-in body instead of letting it skip the bucket", async () => {
    // The escape this closes: the limiter declines to parse a body over 8 KB,
    // and used to fall back to the per-IP tiers. On /api/auth/sign-in/email
    // there are none — resolveRateLimitTiers stands aside for the whole prefix
    // — so a padded attempt left the per-credential bucket for nothing at all,
    // and three sources in a row were all served (this test asserted 200).
    // bodyLimitMiddleware does not cover it: its ceiling is 1 MB, and 20 KB
    // sails through, pinned by the full-stack test below.
    const { app } = buildLimitedApp();
    const body = JSON.stringify({
      email: "reader@example.com",
      password: "wrong",
      pad: "x".repeat(20_000),
    });

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
      expect(res.status, source).toBe(413);
    }
  });

  it("refuses an oversized body even behind the real 1 MB body limit", async () => {
    // The residual is exactly the 8 KB .. 1 MB window: bodyLimitMiddleware
    // answers 413 above 1 MB and waves everything below it through, so the two
    // guards do not overlap and the padded request really did reach the limiter
    // unbucketed. Full stack, in app.ts order.
    const app = new Hono<{ Variables: AppVariables }>();
    const storage = createMemoryKVStore();
    const env = {
      NODE_ENV: "production",
      E2E_TEST: "",
      LIBRIS_RATELIMIT_GENERAL_LIMIT: 100,
      LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
      LIBRIS_RATELIMIT_AUTH_LIMIT: 2,
      LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
      LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 100,
      LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 60,
    } as Env;
    app.use("*", async (c, next) => {
      c.set("env", env);
      c.set("redisStorage", storage);
      c.set("clientIp", "203.0.113.7");
      await next();
    });
    app.use("*", bodyLimitMiddleware);
    app.use("*", rateLimitMiddleware);
    app.all("*", (c) => c.json({ ok: true }));

    const body = JSON.stringify({ email: "reader@example.com", pad: "x".repeat(20_000) });
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(res.status).toBe(413);
  });

  it("refuses an oversized KoSync auth body too", async () => {
    // KoSync does have a per-IP auth tier behind it, so the escape was narrower
    // here — but it is still an escape from the per-username budget, and no
    // KOReader login body is 8 KB.
    const { app } = buildLimitedApp();
    const body = JSON.stringify({ username: "reader", password: "x".repeat(20_000) });

    const res = await app.request("/kosync/users/auth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-test-source": "198.51.100.9",
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  it("measures the body rather than trusting content-length", async () => {
    // The old guard consulted the declared header alone. A request that sends
    // no content-length (chunked) never met the ceiling at all.
    const { app } = buildLimitedApp();
    const body = JSON.stringify({ email: "reader@example.com", pad: "x".repeat(20_000) });

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-source": "198.51.100.10" },
      body,
    });
    expect(res.status).toBe(413);
  });

  it("still serves an ordinary sign-in body", async () => {
    // The refusal must not become a new way to turn away legitimate traffic.
    const { app } = buildLimitedApp();
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-source": "198.51.100.11" },
      body: JSON.stringify({ email: "reader@example.com", password: "correct horse" }),
    });
    expect(res.status).toBe(200);
  });
});
