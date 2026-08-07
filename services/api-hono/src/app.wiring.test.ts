/**
 * Tests for the app-level wiring in app.ts: middleware order, the global error
 * mapper, and the validation hook every mounted router has to carry.
 *
 * These are deliberately structural. The defects they pin (59m.8, 59m.22,
 * 59m.43) were all "the pieces are individually correct but assembled wrong",
 * and every behavioural probe for them came out identical either way.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { APIError } from "better-auth/api";
import { createApp } from "./app.js";
import type { AppServices } from "./bootstrap.js";
import type { Env } from "./env.js";
import { bodyLimitMiddleware } from "./middleware/body-limit.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { createMemoryKVStore } from "./services/kv-store.js";

const TEST_ENV = {
  NODE_ENV: "test",
  E2E_TEST: "",
  TRUST_PROXY_HEADERS: "0",
  LIBRIS_TRUSTED_PROXIES: [],
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
} as unknown as Env;

/**
 * The stack under test never reaches a handler: bodyLimit answers 413 first.
 * Nothing here is exercised, so a stub keeps the suite off Postgres and Redis.
 */
function createStubServices(): AppServices {
  return {
    redisStorage: createMemoryKVStore(),
    cacheStorage: createMemoryKVStore(),
  } as unknown as AppServices;
}

function buildApp() {
  return createApp({ services: createStubServices(), env: TEST_ENV }).app;
}

describe("middleware order", () => {
  it("caps the body before the rate limiter is allowed to read it", () => {
    // rateLimitMiddleware clones and parses the JSON body to derive the
    // per-credential bucket. Registered first, it buffered an unbounded,
    // unauthenticated body into memory before bodyLimit could refuse it.
    const handlers = buildApp().routes.map((route) => route.handler);
    const bodyLimitIndex = handlers.indexOf(bodyLimitMiddleware);
    const rateLimitIndex = handlers.indexOf(rateLimitMiddleware);

    expect(bodyLimitIndex, "bodyLimitMiddleware is registered").toBeGreaterThanOrEqual(0);
    expect(rateLimitIndex, "rateLimitMiddleware is registered").toBeGreaterThanOrEqual(0);
    expect(bodyLimitIndex).toBeLessThan(rateLimitIndex);
  });

  it("rejects an oversized unauthenticated sign-in body with 413", async () => {
    const res = await buildApp().request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.com", password: "x".repeat(2_000_000) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("global error mapping", () => {
  it("maps a better-auth APIError to its own status, not 500", async () => {
    const app = buildApp();
    // A route that throws the way auth.api.* does. Registered after createApp
    // so it inherits the same onError.
    app.get("/__wiring/api-error", () => {
      throw new APIError("BAD_REQUEST", {
        message: "name is too long",
        code: "INVALID_NAME_LENGTH",
      });
    });

    const res = await app.request("/__wiring/api-error");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is too long" });
  });

  it("does not leak the message of a 5xx APIError", async () => {
    const app = buildApp();
    app.get("/__wiring/api-error-500", () => {
      throw new APIError("INTERNAL_SERVER_ERROR", {
        message: "connect ECONNREFUSED 10.0.0.9:5432",
      });
    });

    const res = await app.request("/__wiring/api-error-500");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});

describe("validation hook coverage", () => {
  const routesDir = fileURLToPath(new URL("./routes/", import.meta.url));
  const routeFiles = readdirSync(routesDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();

  it("gives every mounted router the shared validation hook", async () => {
    // @hono/zod-openapi resolves the hook at .openapi() call time from the
    // instance the route is defined on, and route modules build their own
    // OpenAPIHono at import time. A defaultHook on the parent app therefore
    // never reaches them, and their validation failures came back as a raw
    // serialized ZodError. Any router built without the factory fails here.
    const missing: string[] = [];
    let checked = 0;

    for (const file of routeFiles) {
      const mod: Record<string, unknown> = await import(
        /* @vite-ignore */ new URL(file, `file://${routesDir}`).href
      );
      for (const [name, value] of Object.entries(mod)) {
        if (!(value instanceof OpenAPIHono)) continue;
        checked++;
        if (!value.defaultHook) missing.push(`routes/${file} -> ${name}`);
      }
    }

    expect(checked, "found routers to check").toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
