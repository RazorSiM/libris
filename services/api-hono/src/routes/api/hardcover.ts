import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { and, eq, desc } from "drizzle-orm";
import { serviceCredentials, hardcoverSyncLog, books } from "#db";
import type { AppVariables } from "../../context.js";
import { verifyToken } from "../../lib/hardcover/client.js";
import { searchHardcover } from "../../lib/metadata/clients/hardcover.js";
import { isHardcoverMetadataEnabled } from "../../services/settings.js";
import { unsealToken, getApiKeyId } from "../../shared/auth.js";
import { HardcoverSearchResponseSchema } from "../../shared/schemas.js";
import { getQueues } from "../../services/queue.js";
import { parseRedisUrl } from "../../env.js";
import { QUEUE_HARDCOVER_SYNC } from "../../lib/queue/constants.js";
import { Queue } from "bullmq";

// ── GET /status ──────────────────────────────────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["hardcover"],
  summary: "Get Hardcover connection status",
  description:
    "Check whether a Hardcover credential is configured, verify the token with the Hardcover API, and return the connected username and last sync timestamp.",
  responses: {
    200: {
      description: "Connection status",
      content: {
        "application/json": {
          schema: z.object({
            connected: z.boolean(),
            username: z.string().optional(),
            lastSyncAt: z.string().nullable().optional(),
            error: z.string().optional(),
          }),
        },
      },
    },
  },
});

// ── POST /sync ───────────────────────────────────────────────────

const syncRoute = createRoute({
  method: "post",
  path: "/sync",
  tags: ["hardcover"],
  summary: "Trigger Hardcover sync",
  description:
    "Enqueue a job to synchronize reading progress and ratings with the Hardcover service. Requires a configured Hardcover credential.",
  responses: {
    200: {
      description: "Sync job enqueued",
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
    },
    400: { description: "Hardcover credential not configured" },
  },
});

// ── GET /sync/log ────────────────────────────────────────────────

const syncLogRoute = createRoute({
  method: "get",
  path: "/sync/log",
  tags: ["hardcover"],
  summary: "List Hardcover sync log entries",
  description:
    "Return recent Hardcover sync log entries joined with book titles, sorted by last synced timestamp descending.",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Maximum entries to return",
      }),
    }),
  },
  responses: {
    200: {
      description: "Array of sync log entries",
      content: {
        "application/json": {
          schema: z.array(
            z.object({
              bookId: z.string().uuid(),
              bookTitle: z.string().nullable(),
              status: z.string().nullable(),
              progress: z.string().nullable(),
              rating: z.string().nullable(),
              syncedAt: z.coerce.date(),
            }),
          ),
        },
      },
    },
  },
});

// ── GET /search ──────────────────────────────────────────────────

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  tags: ["hardcover"],
  summary: "Search Hardcover for metadata",
  description:
    "Run a free-text search against Hardcover and return up to 5 normalized metadata candidates. Used by the UI when auto-fetched metadata is wrong or missing — the user picks a result to autofill the edit form.",
  request: {
    query: z.object({
      q: z
        .string()
        .min(2, "Query must be at least 2 characters")
        .max(200, "Query must be 200 characters or fewer")
        .openapi({ description: "Search query — title, author, ISBN, or any combination" }),
    }),
  },
  responses: {
    200: {
      description: "Search results (may be empty)",
      content: {
        "application/json": { schema: HardcoverSearchResponseSchema },
      },
    },
    503: { description: "Hardcover credential not configured or metadata search disabled" },
  },
});

// ── Router ───────────────────────────────────────────────────────

export const hardcoverRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(statusRoute, async (c) => {
    const db = c.get("db");
    const env = c.get("env");
    const apiKeyId = getApiKeyId(c);

    // Check if credential exists
    const [cred] = await db
      .select({ passwordHash: serviceCredentials.passwordHash })
      .from(serviceCredentials)
      .where(
        and(eq(serviceCredentials.service, "hardcover"), eq(serviceCredentials.apiKeyId, apiKeyId)),
      )
      .limit(1);

    if (!cred) {
      return c.json({ connected: false });
    }

    // Decrypt the stored token (Hardcover uses reversible encryption, not bcrypt)
    const token = await unsealToken(cred.passwordHash, env.API_SECRET_KEY);
    if (!token) {
      return c.json({ connected: false, error: "Failed to decrypt stored token" });
    }

    const verify = await verifyToken(token);

    if (!verify.ok) {
      return c.json({
        connected: false,
        error: `Token invalid: ${verify.error.type}`,
      });
    }

    // Get last sync timestamp for this user
    const [lastSync] = await db
      .select({ lastSyncedAt: hardcoverSyncLog.lastSyncedAt })
      .from(hardcoverSyncLog)
      .where(eq(hardcoverSyncLog.apiKeyId, apiKeyId))
      .orderBy(desc(hardcoverSyncLog.lastSyncedAt))
      .limit(1);

    return c.json({
      connected: true,
      username: verify.data.username,
      lastSyncAt: lastSync?.lastSyncedAt?.toISOString() ?? null,
    });
  })
  .openapi(syncRoute, async (c) => {
    const db = c.get("db");
    const env = c.get("env");
    const apiKeyId = getApiKeyId(c);

    const [cred] = await db
      .select({ id: serviceCredentials.id })
      .from(serviceCredentials)
      .where(
        and(eq(serviceCredentials.service, "hardcover"), eq(serviceCredentials.apiKeyId, apiKeyId)),
      )
      .limit(1);

    if (!cred) {
      throw new HTTPException(400, { message: "Hardcover credential not configured" });
    }

    const { close: _, ...queues } = getQueues();
    const syncQueue = Object.values(queues).find(
      (q): q is Queue => q instanceof Queue && q.name === QUEUE_HARDCOVER_SYNC,
    );

    const jobPayload = { manual: true, apiKeyId };

    if (!syncQueue) {
      // Fallback: create a one-off queue connection
      const connection = parseRedisUrl(env.REDIS_URL);
      const q = new Queue(QUEUE_HARDCOVER_SYNC, { connection });
      await q.add("manual-sync", jobPayload);
      await q.close();
    } else {
      await syncQueue.add("manual-sync", jobPayload);
    }

    return c.json({ message: "Sync job enqueued" });
  })
  .openapi(syncLogRoute, async (c) => {
    const { limit } = c.req.valid("query");
    const db = c.get("db");
    const apiKeyId = getApiKeyId(c);

    const rows = await db
      .select({
        bookId: hardcoverSyncLog.bookId,
        bookTitle: books.title,
        status: hardcoverSyncLog.lastStatus,
        progress: hardcoverSyncLog.lastProgress,
        rating: hardcoverSyncLog.lastRating,
        syncedAt: hardcoverSyncLog.lastSyncedAt,
      })
      .from(hardcoverSyncLog)
      .innerJoin(books, eq(hardcoverSyncLog.bookId, books.id))
      .where(eq(hardcoverSyncLog.apiKeyId, apiKeyId))
      .orderBy(desc(hardcoverSyncLog.lastSyncedAt))
      .limit(limit);

    return c.json(rows);
  })
  .openapi(searchRoute, async (c) => {
    const { q } = c.req.valid("query");
    const db = c.get("db");

    // Surface clear status codes when Hardcover is unusable, instead of the
    // silent empty-array behavior of searchHardcover().
    const enabled = await isHardcoverMetadataEnabled(db);
    if (!enabled) {
      throw new HTTPException(503, { message: "Hardcover metadata search is disabled" });
    }

    const [cred] = await db
      .select({ id: serviceCredentials.id })
      .from(serviceCredentials)
      .where(eq(serviceCredentials.service, "hardcover"))
      .limit(1);
    if (!cred) {
      throw new HTTPException(503, { message: "Hardcover credential not configured" });
    }

    const results = await searchHardcover({ title: q });
    return c.json({
      results: results.map((r) => ({
        source: r.source,
        normalized: r.normalized,
        confidence: r.confidence,
      })),
    });
  });
