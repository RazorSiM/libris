/**
 * Two health endpoints, two costs.
 *
 * `/api/health` is the readiness/deep check: it verifies Postgres, Redis and
 * the event bus, and an operator reads its answer during an incident. That is
 * worth a round trip, and its semantics are deliberately unchanged here.
 *
 * `/api/health/live` is the liveness probe an orchestrator runs on a timer. It
 * must cost nothing, so this suite serves it with a database double that throws
 * on *any* property access and a Redis module whose health call throws. If the
 * handler ever grows a dependency check, these stop returning 200.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { authMiddleware } from "../../middleware/auth.js";
import { resolvePolicy } from "../../shared/route-policy.js";

const redisFixture = vi.hoisted(() => ({
  isRedisHealthy: vi.fn(() => {
    throw new Error("Redis touched");
  }),
}));

const eventBusFixture = vi.hoisted(() => ({
  isEventBusHealthy: vi.fn(() => {
    throw new Error("event bus touched");
  }),
}));

vi.mock("../../services/redis.js", () => ({
  isRedisHealthy: redisFixture.isRedisHealthy,
  getSharedRedis: () => null,
}));

vi.mock("../../services/event-bus.js", () => ({
  isEventBusHealthy: eventBusFixture.isEventBusHealthy,
  initEventBus: () => {},
  getEventBus: () => ({ publish: () => {} }),
}));

const { healthRoutes } = await import("./health.js");

/**
 * A database that cannot be used without saying so. Reading any property off it
 * throws, which is a stronger claim than "execute was not called": it also
 * catches a handler that reaches for `db.query`, a transaction, or the pool.
 */
function createExplodingDb(): Db {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`database touched: ${String(property)}`);
      },
    },
  ) as Db;
}

interface BuildOptions {
  db?: Db;
  nodeEnv?: string;
  /** Set to simulate an authenticated caller, who gets per-check detail. */
  userId?: string;
}

function buildApp({ db = createExplodingDb(), nodeEnv = "production", userId }: BuildOptions = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("env", { NODE_ENV: nodeEnv } as Env);
    if (userId) c.set("userId", userId);
    await next();
  });
  app.route("/api/health", healthRoutes);
  return app;
}

describe("GET /api/health/live", () => {
  it("answers 200 without touching the database, Redis or the event bus", async () => {
    redisFixture.isRedisHealthy.mockClear();
    eventBusFixture.isEventBusHealthy.mockClear();
    const app = buildApp();

    const res = await app.request("/api/health/live");

    // A 500 here means the handler reached one of the doubles above.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "api" });
    expect(redisFixture.isRedisHealthy).not.toHaveBeenCalled();
    expect(eventBusFixture.isEventBusHealthy).not.toHaveBeenCalled();
  });

  it("answers the same when every dependency is down", async () => {
    // The point of separating the two: a liveness probe wired to the deep check
    // restarts the container when Postgres is unreachable, which is the one
    // moment a restart cannot help. This endpoint reports the process, only.
    const app = buildApp({ nodeEnv: "production" });

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await app.request("/api/health/live");
      expect(res.status, `attempt ${attempt}`).toBe(200);
    }
  });

  it("is reachable unauthenticated, and without a session lookup", () => {
    // "public", not "optional". Policy "optional" calls auth.api.getSession for
    // any caller presenting a cookie — a Redis read and possibly a Postgres one
    // — which would put I/O back on the path this route exists to keep free.
    expect(resolvePolicy("/api/health/live")).toBe("public");
  });

  it("answers 200 through the real auth middleware, cookie or not", async () => {
    // The policy assertion above says what the table holds; this says what the
    // middleware does with it. Without the table entry the path falls through
    // to the /api/ catch-all and answers 401 — an orchestrator would see a
    // permanently unhealthy container.
    // Returns null rather than throwing, so a regression shows up as the 401
    // an orchestrator would actually see rather than as a 500.
    const getSession = vi.fn(async () => null);
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("db", createExplodingDb());
      c.set("env", { NODE_ENV: "production" } as Env);
      c.set("auth", { api: { getSession } } as never);
      c.set("clientIp", "192.0.2.1");
      await next();
    });
    app.use("*", authMiddleware);
    app.route("/api/health", healthRoutes);

    const cases: Record<string, string>[] = [{}, { cookie: "better-auth.session_token=whatever" }];
    for (const headers of cases) {
      const res = await app.request("/api/health/live", { headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  it("still performs the database round trip", async () => {
    const execute = vi.fn(async () => []);
    const app = buildApp({ db: { execute } as unknown as Db, nodeEnv: "test" });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ status: "ok", service: "api" });
  });

  it("still performs the Redis and event-bus checks outside test/dev", async () => {
    redisFixture.isRedisHealthy.mockClear();
    eventBusFixture.isEventBusHealthy.mockClear();
    redisFixture.isRedisHealthy.mockReturnValue({ ok: true, latencyMs: 1 } as never);
    eventBusFixture.isEventBusHealthy.mockReturnValue({ ok: true } as never);
    const app = buildApp({ db: { execute: vi.fn(async () => []) } as unknown as Db, userId: "u1" });

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(redisFixture.isRedisHealthy).toHaveBeenCalledTimes(1);
    expect(eventBusFixture.isEventBusHealthy).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      status: "ok",
      service: "api",
      checks: { database: { status: "ok" }, redis: { status: "ok" }, eventBus: { status: "ok" } },
    });

    redisFixture.isRedisHealthy.mockReset();
    eventBusFixture.isEventBusHealthy.mockReset();
    redisFixture.isRedisHealthy.mockImplementation(() => {
      throw new Error("Redis touched");
    });
    eventBusFixture.isEventBusHealthy.mockImplementation(() => {
      throw new Error("event bus touched");
    });
  });

  it("reports 503 when the database is unreachable", async () => {
    // The behaviour anything probing /api/health today depends on. Unchanged.
    const execute = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = buildApp({ db: { execute } as unknown as Db, nodeEnv: "test" });

    const res = await app.request("/api/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error", service: "api" });
  });

  it("keeps its exact-match optional-auth policy", () => {
    expect(resolvePolicy("/api/health")).toBe("optional");
  });
});
