import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { kosyncCredentials, serviceCredentials } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin, requireAdmin } from "../../shared/auth.js";
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
  description:
    "Return application settings. Filesystem paths are included only for administrators.",
  responses: {
    200: {
      description: "Current settings",
      content: {
        "application/json": {
          schema: z.object({
            libraryPath: z.string().optional(),
            inboxPath: z.string().optional(),
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
            // No `kosyncConfigured` here on purpose. It used to be a second,
            // independently-computed copy of `credentials.kosync.configured`
            // in the very same payload, and the two disagreed: this one read
            // `service_credentials`, which the kosync_credentials migration
            // emptied and no writer has touched since, so it was pinned to
            // false forever (libris-59m.18). One field, one query, one answer.
            settings: z
              .object({
                libraryPath: z.string(),
                inboxPath: z.string(),
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

export const settingsRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(settingsStatusRoute, async (c) => {
    const db = c.get("db");
    const env = c.get("env");
    const userId = getUserId(c);
    const admin = isAdmin(c);

    // Non-admin users only need their credential connection status.
    //
    // KoSync lives in its own table, keyed by user rather than by (user,
    // service), so it cannot be folded into the service_credentials loop below.
    // Reading it from the wrong table leaves the settings form permanently
    // blank while GET /api/credentials/kosync happily reports it configured.
    const credentialsPromise = (async () => {
      const kosyncPromise = db
        .select({
          username: kosyncCredentials.username,
          createdAt: kosyncCredentials.createdAt,
          updatedAt: kosyncCredentials.updatedAt,
        })
        .from(kosyncCredentials)
        .where(eq(kosyncCredentials.userId, userId))
        .limit(1)
        .then(([row]) =>
          row
            ? {
                configured: true as const,
                service: "kosync" as const,
                username: row.username,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
              }
            : { configured: false as const, service: "kosync" as const },
        );

      const services = ["opds", "hardcover"] as const;
      const results = await Promise.all([
        ...services.map(async (service) => {
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
        kosyncPromise,
      ]);

      // Keyed by service rather than by position: the three come from two
      // different tables, so the array order is an implementation detail and a
      // positional read silently mislabels them the moment it changes.
      const byService = Object.fromEntries(results.map((r) => [r.service, r]));
      return {
        opds: byService.opds!,
        kosync: byService.kosync!,
        hardcover: byService.hardcover!,
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
        //
        // KoSync deliberately does not appear here — `credentials.kosync` in
        // this same response is the single source of truth for it.
        (async () => {
          const [hardcoverMetadataEnabled, hardcoverSyncEnabled] = await Promise.all([
            isHardcoverMetadataEnabled(db),
            isHardcoverSyncEnabled(db),
          ]);

          return {
            libraryPath: env.LIBRIS_LIBRARY_PATH,
            inboxPath: env.LIBRIS_INBOX_PATH,
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

    // kosync_credentials, never service_credentials: the migration that split
    // KoSync out deleted every kosync row from the latter and nothing writes
    // one back, so a lookup there answers "not configured" forever
    // (libris-59m.18). GET /status deliberately reports this through
    // `credentials.kosync` instead of carrying a second copy of the flag.
    const [kosyncCred] = await db
      .select({ userId: kosyncCredentials.userId })
      .from(kosyncCredentials)
      .where(eq(kosyncCredentials.userId, userId))
      .limit(1);

    const kosyncConfigured = !!kosyncCred;

    const [hardcoverMetadataEnabled, hardcoverSyncEnabled] = await Promise.all([
      isHardcoverMetadataEnabled(db),
      isHardcoverSyncEnabled(db),
    ]);

    return c.json({
      ...(isAdmin(c)
        ? { libraryPath: env.LIBRIS_LIBRARY_PATH, inboxPath: env.LIBRIS_INBOX_PATH }
        : {}),
      kosyncConfigured,
      hardcoverMetadataEnabled,
      hardcoverSyncEnabled,
    });
  })
  .openapi(patchSettingsRoute, async (c) => {
    requireAdmin(c);
    const db = c.get("db");
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

    // No invalidation: GET /api/settings is not cached (nor is any other route
    // these toggles affect), so the call this used to make could never match a
    // key. The Hardcover toggles change no OPDS feed and no /api/stats figure.

    return c.json({ updated }, 200);
  });
