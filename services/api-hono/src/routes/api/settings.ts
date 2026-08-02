import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { serviceCredentials } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin, requireAdmin } from "../../shared/auth.js";
import { invalidateRouteCache } from "../../services/cache.js";
import { isRedisHealthy } from "../../services/redis.js";
import { isEventBusHealthy } from "../../services/event-bus.js";
import {
  collectFailedJobs,
  collectQueueCounts,
  getRegisteredQueues,
  type FailedJob,
  type QueueCounts,
} from "../../services/queue-diagnostics.js";
import {
  setAppSetting,
  isHardcoverMetadataEnabled,
  isHardcoverSyncEnabled,
} from "../../services/settings.js";

import { getLogger } from "../../lib/logger.js";

const logger = getLogger("settings");

// --- GET / ---

const getSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["settings"],
  summary: "Get settings",
  description: "Return current library and inbox path settings",
  responses: {
    200: {
      description: "Current settings",
      content: {
        "application/json": {
          schema: z.object({
            libraryPath: z.string(),
            inboxPath: z.string(),
            kosyncConfigured: z.boolean(),
            hardcoverMetadataEnabled: z.boolean(),
            hardcoverSyncEnabled: z.boolean(),
          }),
        },
      },
    },
  },
});

// --- PATCH / ---

const PatchBodySchema = z.object({
  hardcoverMetadataEnabled: z.boolean().optional(),
  hardcoverSyncEnabled: z.boolean().optional(),
});

const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["settings"],
  summary: "Update settings",
  description:
    "Update persistent application settings (Hardcover integration toggles). " +
    "Library and inbox paths are configured via the LIBRIS_LIBRARY_PATH and LIBRIS_INBOX_PATH " +
    "environment variables and cannot be changed at runtime.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PatchBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Settings updated",
      content: {
        "application/json": {
          schema: z.object({
            updated: z.array(z.string()),
          }),
        },
      },
    },
    400: { description: "No valid settings provided" },
  },
});

// --- GET /status (aggregate) ---

const CheckSchema = z.object({
  status: z.enum(["ok", "error"]),
  latencyMs: z.number().int().optional(),
  error: z.string().optional(),
});

const CredentialStatusItemSchema = z.object({
  configured: z.boolean(),
  service: z.string(),
  username: z.string().optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().nullable().optional(),
});

const settingsStatusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["settings"],
  summary: "Get full settings page status",
  description:
    "Aggregate endpoint that returns health checks, job queue status, failed jobs, " +
    "app settings, and all credential statuses in a single request. " +
    "Non-admin users receive only their credential connection status; " +
    "admin users receive the full diagnostics payload.",
  responses: {
    200: {
      description: "Aggregated settings status",
      content: {
        "application/json": {
          schema: z.object({
            health: z
              .object({
                status: z.enum(["ok", "degraded", "error"]),
                checks: z.object({
                  database: CheckSchema,
                  redis: CheckSchema,
                  eventBus: CheckSchema,
                }),
              })
              .nullable(),
            queues: z
              .record(
                z.string(),
                z.object({
                  waiting: z.number().int(),
                  active: z.number().int(),
                  completed: z.number().int(),
                  failed: z.number().int(),
                  delayed: z.number().int(),
                  paused: z.number().int(),
                }),
              )
              .nullable(),
            failedJobs: z
              .object({
                jobs: z.array(
                  z.object({
                    id: z.string(),
                    queueName: z.string(),
                    name: z.string(),
                    data: z.record(z.string(), z.unknown()),
                    error: z.string(),
                    failedAt: z.number(),
                    attemptsMade: z.number().int(),
                    maxAttempts: z.number().int(),
                  }),
                ),
                total: z.number().int(),
              })
              .nullable(),
            settings: z
              .object({
                libraryPath: z.string(),
                inboxPath: z.string(),
                kosyncConfigured: z.boolean(),
                hardcoverMetadataEnabled: z.boolean(),
                hardcoverSyncEnabled: z.boolean(),
              })
              .nullable(),
            credentials: z.object({
              opds: CredentialStatusItemSchema,
              kosync: CredentialStatusItemSchema,
              hardcover: CredentialStatusItemSchema,
            }),
          }),
        },
      },
    },
  },
});

type HealthCheck = { status: "ok" | "error"; latencyMs?: number; error?: string };

export const settingsRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(settingsStatusRoute, async (c) => {
    const db = c.get("db");
    const env = c.get("env");
    const userId = getUserId(c);
    const admin = isAdmin(c);

    // Non-admin users only need their credential connection status
    const credentialsPromise = (async () => {
      const services = ["opds", "kosync", "hardcover"] as const;
      const results = await Promise.all(
        services.map(async (service) => {
          const [row] = await db
            .select({
              username: serviceCredentials.username,
              createdAt: serviceCredentials.createdAt,
              updatedAt: serviceCredentials.updatedAt,
            })
            .from(serviceCredentials)
            .where(
              and(eq(serviceCredentials.service, service), eq(serviceCredentials.userId, userId)),
            )
            .limit(1);

          if (!row) {
            return { configured: false as const, service };
          }
          return {
            configured: true as const,
            service,
            username: row.username,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }),
      );

      return {
        opds: results[0]!,
        kosync: results[1]!,
        hardcover: results[2]!,
      };
    })();

    // Non-admin: return only credentials, null out diagnostics
    if (!admin) {
      const credentialsResult = await credentialsPromise;
      return c.json({
        health: null,
        queues: null,
        failedJobs: null,
        settings: null,
        credentials: credentialsResult,
      });
    }

    // Admin: run ALL sub-queries in parallel
    const [healthResult, queuesResult, failedJobsResult, settingsResult, credentialsResult] =
      await Promise.all([
        // 1. Health checks (DB + Redis)
        (async () => {
          const checks: Record<string, HealthCheck> = {};

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

          const redisHealth = await isRedisHealthy();
          checks.redis = {
            status: redisHealth.ok ? "ok" : "error",
            latencyMs: redisHealth.latencyMs,
            ...(redisHealth.error && { error: redisHealth.error }),
          };

          const ebHealth = isEventBusHealthy();
          checks.eventBus = {
            status: ebHealth.ok ? "ok" : "error",
            ...(ebHealth.error && { error: ebHealth.error }),
          };

          const overall = Object.values(checks).every((ch) => ch.status === "ok")
            ? ("ok" as const)
            : ("degraded" as const);

          return {
            status: overall,
            checks: {
              database: checks.database!,
              redis: checks.redis!,
              eventBus: checks.eventBus!,
            },
          };
        })(),

        // 2. Queue job counts (all registered queues: pipeline + scheduler + maintenance)
        (async () => {
          try {
            return await collectQueueCounts(getRegisteredQueues());
          } catch {
            // Redis may be unavailable
            return {} as Record<string, QueueCounts>;
          }
        })(),

        // 3. Failed jobs (all registered queues)
        (async () => {
          try {
            return await collectFailedJobs(getRegisteredQueues());
          } catch {
            // Redis may be unavailable
            return { jobs: [] as FailedJob[], total: 0 };
          }
        })(),

        // 4. App settings
        (async () => {
          const [kosyncCred] = await db
            .select({ id: serviceCredentials.id })
            .from(serviceCredentials)
            .where(
              and(eq(serviceCredentials.service, "kosync"), eq(serviceCredentials.userId, userId)),
            )
            .limit(1);

          const kosyncConfigured = !!kosyncCred;

          const [hardcoverMetadataEnabled, hardcoverSyncEnabled] = await Promise.all([
            isHardcoverMetadataEnabled(db),
            isHardcoverSyncEnabled(db),
          ]);

          return {
            libraryPath: env.LIBRIS_LIBRARY_PATH,
            inboxPath: env.LIBRIS_INBOX_PATH,
            kosyncConfigured,
            hardcoverMetadataEnabled,
            hardcoverSyncEnabled,
          };
        })(),

        // 5. All credential statuses
        credentialsPromise,
      ]);

    return c.json({
      health: healthResult,
      queues: queuesResult,
      failedJobs: failedJobsResult,
      settings: settingsResult,
      credentials: credentialsResult,
    });
  })
  .openapi(getSettingsRoute, async (c) => {
    const db = c.get("db");
    const env = c.get("env");
    const userId = getUserId(c);

    const [kosyncCred] = await db
      .select({ id: serviceCredentials.id })
      .from(serviceCredentials)
      .where(and(eq(serviceCredentials.service, "kosync"), eq(serviceCredentials.userId, userId)))
      .limit(1);

    const kosyncConfigured = !!kosyncCred;

    const [hardcoverMetadataEnabled, hardcoverSyncEnabled] = await Promise.all([
      isHardcoverMetadataEnabled(db),
      isHardcoverSyncEnabled(db),
    ]);

    return c.json({
      libraryPath: env.LIBRIS_LIBRARY_PATH,
      inboxPath: env.LIBRIS_INBOX_PATH,
      kosyncConfigured,
      hardcoverMetadataEnabled,
      hardcoverSyncEnabled,
    });
  })
  .openapi(patchSettingsRoute, async (c) => {
    requireAdmin(c);
    const db = c.get("db");
    const cacheStorage = c.get("cacheStorage");
    const body = c.req.valid("json");
    const updated: string[] = [];

    // Handle persistent boolean settings
    const booleanSettings = {
      hardcoverMetadataEnabled: "hardcover.metadataEnabled",
      hardcoverSyncEnabled: "hardcover.syncEnabled",
    } as const;

    for (const [bodyKey, dbKey] of Object.entries(booleanSettings)) {
      const value = body[bodyKey as keyof typeof booleanSettings];
      if (value === undefined) continue;
      await setAppSetting(db, dbKey, value);
      updated.push(bodyKey);
    }

    if (updated.length === 0) {
      throw new HTTPException(400, { message: "No valid settings provided" });
    }

    // Invalidate cached settings response
    await invalidateRouteCache(cacheStorage, "/api/settings");

    return c.json({ updated }, 200);
  });
