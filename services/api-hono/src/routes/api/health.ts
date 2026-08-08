import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { sql } from "drizzle-orm";
import type { AppVariables } from "../../context.js";
import { isRedisHealthy } from "../../services/redis.js";
import { isEventBusHealthy } from "../../services/event-bus.js";
import { getLogger } from "../../lib/logger.js";

const logger = getLogger("health");

const CheckSchema = z.object({
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().int().optional(),
  error: z.string().optional(),
});

/**
 * Liveness: is this process up and serving?
 *
 * Deliberately separate from the readiness check below, and deliberately
 * I/O-free (libris-tnu). `/api/health` answers the question an operator asks
 * during an incident — "can the API reach Postgres and Redis?" — and answering
 * it costs a `SELECT 1` plus a Redis `PING` on an unauthenticated path. A
 * container liveness probe asks a much narrower question on a timer, forever,
 * and should not pay for the wide one: a probe wired to the deep check restarts
 * the container when the *database* is down, which is the one moment a restart
 * cannot help.
 *
 * So this handler touches nothing. No `c.get("db")`, no Redis, no event bus —
 * reaching it at all is the entire signal. Pinned by health.test.ts, which
 * serves it with a database double that throws on any property access.
 *
 * `/api/health`'s semantics are unchanged; operators opt in to this one.
 */
const livenessRoute = createRoute({
  method: "get",
  path: "/live",
  tags: ["health"],
  summary: "Liveness probe",
  description:
    "Answers 200 as soon as the process is serving HTTP. Performs no database, Redis or event-bus I/O, so it stays cheap at the frequency an orchestrator probes at and never fails because a dependency is down. Use this for container liveness probes; use GET /api/health for readiness and dependency status.",
  responses: {
    200: {
      description: "The process is up and serving requests",
      content: {
        "application/json": {
          schema: z.object({
            status: z
              .literal("ok")
              .openapi({ description: "Always `ok` — reaching the route is the signal" }),
            service: z.literal("api"),
          }),
        },
      },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["health"],
  summary: "Health check (readiness)",
  description:
    "Deep readiness check: verifies the database, Redis and the event bus, and answers 503 when any of them is degraded. Returns minimal status for unauthenticated requests; provide a valid API key for per-dependency detail. Costs one database round-trip and one Redis PING per call — probe GET /api/health/live instead for container liveness.",
  responses: {
    200: {
      description: "All systems healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["ok", "degraded", "error"]),
            service: z.string(),
            checks: z
              .object({
                database: CheckSchema,
                redis: CheckSchema,
                eventBus: CheckSchema,
              })
              .optional(),
          }),
        },
      },
    },
    503: {
      description: "One or more systems degraded",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["ok", "degraded", "error"]),
            service: z.string(),
            checks: z
              .object({
                database: CheckSchema,
                redis: CheckSchema,
                eventBus: CheckSchema,
              })
              .optional(),
          }),
        },
      },
    },
  },
});

export const healthRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(livenessRoute, (c) => c.json({ status: "ok" as const, service: "api" as const }, 200))
  .openapi(healthRoute, async (c) => {
    const db = c.get("db");

    const checks: Record<string, { status: "ok" | "error"; latencyMs?: number; error?: string }> =
      {};

    // DB check
    const dbStart = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err) {
      logger.withMetadata({ error: String(err) }).warn("DB health check failed");
      checks.database = {
        status: "error",
        latencyMs: Date.now() - dbStart,
        error: err instanceof Error ? err.message : "Unknown error",
      };
    }

    // Redis check via shared ioredis instance
    const env = c.get("env");
    const isTestOrDev = env.NODE_ENV === "test" || env.NODE_ENV === "development";

    if (isTestOrDev) {
      // No Redis in test/dev — KV store is in-memory, so always healthy
      checks.redis = { status: "ok", latencyMs: 0 };
      checks.eventBus = { status: "ok" };
    } else {
      const redisHealth = await isRedisHealthy();
      checks.redis = {
        status: redisHealth.ok ? "ok" : "error",
        latencyMs: redisHealth.latencyMs,
        ...(redisHealth.error && { error: redisHealth.error }),
      };

      // Event bus check
      const ebHealth = isEventBusHealthy();
      checks.eventBus = {
        status: ebHealth.ok ? "ok" : "error",
        ...(ebHealth.error && { error: ebHealth.error }),
      };
    }

    const overall = Object.values(checks).every((ch) => ch.status === "ok")
      ? "ok"
      : ("degraded" as const);

    // Authenticated requests get full detail; public requests get minimal status
    if (c.get("userId")) {
      const status = overall === "ok" ? 200 : 503;
      return c.json(
        {
          status: overall,
          service: "api" as const,
          checks: {
            database: checks.database!,
            redis: checks.redis!,
            eventBus: checks.eventBus!,
          },
        },
        status,
      );
    }

    const minimalStatus = overall === "ok" ? ("ok" as const) : ("error" as const);
    const httpStatus = overall === "ok" ? 200 : 503;
    return c.json({ status: minimalStatus, service: "api" as const }, httpStatus);
  });
