import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
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

/**
 * The half of `GET /api/settings` that only administrators receive.
 *
 * These are host filesystem paths. `GET /api/settings` is the one endpoint on
 * this prefix a non-admin may call, so the role branch that withholds them
 * lived as an inline `...(isAdmin(c) ? {…} : {})` spread inside the handler's
 * return statement — invisible to anyone auditing which surfaces disclose
 * paths, and invisible to the OpenAPI document, which declared both as plain
 * optionals with no stated authority.
 *
 * Naming the projection fixes both: the fields are declared in one place that
 * states their authority in the spec itself, and `adminOnlySettings()` below is
 * the only code that can produce them. Adding a field here without granting it
 * there is a type error; granting it without a description naming the authority
 * fails the contract test in `settings.test.ts`.
 *
 * Why optional-with-stated-authority rather than a discriminated union of an
 * admin and a non-admin response: OpenAPI discriminates on a value IN the
 * payload, and there is no such value here — the variance is in the caller's
 * role, which the body does not carry. Modelling it as a union would mean
 * inventing a `role` discriminant field purely to satisfy the document, i.e.
 * changing the API to describe it. `oneOf` without a discriminator would say
 * "one of these two shapes" and leave the reader no better off than "optional".
 * So: optional fields, but every one of them says whose they are.
 */
const AdminOnlySettingsSchema = z.object({
  libraryPath: z.string().openapi({
    description:
      "Absolute host path of the organized library root. Administrators only — the field is absent entirely for non-admin callers.",
  }),
  inboxPath: z.string().openapi({
    description:
      "Absolute host path of the ingestion inbox. Administrators only — the field is absent entirely for non-admin callers.",
  }),
});

export const SettingsResponseSchema = z
  .object({
    kosyncConfigured: z.boolean(),
    hardcoverMetadataEnabled: z.boolean(),
    hardcoverSyncEnabled: z.boolean(),
  })
  .extend(AdminOnlySettingsSchema.partial().shape)
  .openapi("SettingsResponse");

const getSettingsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["settings"],
  summary: "Get settings",
  description:
    "Return application settings. The response varies by the caller's role: `libraryPath` and " +
    "`inboxPath` are host filesystem paths and are present only for administrators, absent for " +
    "everyone else. The remaining fields are returned to every authenticated caller.",
  responses: {
    200: {
      description:
        "Current settings. Admin callers additionally receive `libraryPath` and `inboxPath`.",
      content: {
        "application/json": {
          schema: SettingsResponseSchema,
        },
      },
    },
  },
});

/**
 * The admin-only fields of `GET /api/settings`, or nothing.
 *
 * The single place `AdminOnlySettingsSchema`'s fields are produced. Keep it
 * that way: an audit of "what discloses filesystem paths" should be able to
 * stop at this function.
 */
export function adminOnlySettings(
  c: Context<{ Variables: AppVariables }>,
  env: { LIBRIS_LIBRARY_PATH: string; LIBRIS_INBOX_PATH: string },
): z.infer<typeof AdminOnlySettingsSchema> | Record<string, never> {
  if (!isAdmin(c)) return {};
  return { libraryPath: env.LIBRIS_LIBRARY_PATH, inboxPath: env.LIBRIS_INBOX_PATH };
}

/** Exported for the contract test — the fields this route withholds by role. */
export const ADMIN_ONLY_SETTINGS_FIELDS = Object.keys(
  AdminOnlySettingsSchema.shape,
) as (keyof z.infer<typeof AdminOnlySettingsSchema>)[];

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
            // Four admin-only sections, each null rather than absent for a
            // non-admin caller. Unlike GET / the variance IS in the
            // declared shape here — but nullable alone does not say WHY, so each
            // one names the authority that decides it.
            health: z
              .object({
                status: z.enum(["ok", "degraded", "error"]),
                checks: z.object({
                  database: CheckSchema,
                  redis: CheckSchema,
                  eventBus: CheckSchema,
                }),
              })
              .nullable()
              .openapi({ description: "Administrators only — null for every other caller." }),
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
              .nullable()
              .openapi({ description: "Administrators only — null for every other caller." }),
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
              .nullable()
              .openapi({
                description:
                  "Administrators only — null for every other caller. Job payloads may quote " +
                  "filesystem paths and request bodies.",
              }),
            // No `kosyncConfigured` here on purpose. It used to be a second,
            // independently-computed copy of `credentials.kosync.configured`
            // in the very same payload, and the two disagreed: this one read
            // `service_credentials`, which the kosync_credentials migration
            // emptied and no writer has touched since, so it was pinned to
            // false forever. One field, one query, one answer.
            settings: z
              .object({
                libraryPath: z.string(),
                inboxPath: z.string(),
                hardcoverMetadataEnabled: z.boolean(),
                hardcoverSyncEnabled: z.boolean(),
              })
              .nullable()
              .openapi({
                description:
                  "Administrators only — null for every other caller. Carries the same host " +
                  "filesystem paths GET /api/settings withholds from non-admins.",
              }),
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
    // one back, so a lookup there answers "not configured" forever. GET
    // /status deliberately reports this through `credentials.kosync` instead
    // of carrying a second copy of the flag.
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
      // Everything below this line goes to every authenticated caller. The
      // role-varying half is `adminOnlySettings` and only `adminOnlySettings` —
      // see AdminOnlySettingsSchema above for why it is spelled that way.
      ...adminOnlySettings(c, env),
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
