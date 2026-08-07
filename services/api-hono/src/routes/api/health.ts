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

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["health"],
  summary: "Health check",
  description:
    "Returns minimal status for unauthenticated requests. Provide a valid API key for detailed check info.",
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

export const healthRoutes = createOpenApiRouter<{ Variables: AppVariables }>().openapi(
  healthRoute,
  async (c) => {
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
  },
);
