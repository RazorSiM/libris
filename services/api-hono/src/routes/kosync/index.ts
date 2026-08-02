import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { readingProgress, readingProgressHistory } from "#db";
import { and, eq, desc } from "drizzle-orm";
import type { AppVariables } from "../../context.js";
import { md5, getUserId } from "../../shared/auth.js";
import { validateKosyncCredentials } from "../../shared/kosync-auth.js";
import type { KosyncAuthResponse, KosyncProgressResponse } from "../../types/kosync.js";

import { getLogger } from "../../lib/logger.js";
import { upsertReadingAggregate } from "../../lib/reading-aggregate.js";
import { resolveBookIdForDocument } from "../../lib/progress-linking.js";

const logger = getLogger("kosync");

const KosyncAuthBody = z.object({ username: z.string().min(1), password: z.string().min(1) });
const KosyncProgressBody = z.object({
  document: z.string().min(1),
  progress: z.string().min(1),
  device: z.string().min(1),
  percentage: z.number().optional(),
  device_id: z.string().optional(),
});

const KosyncAuthResponseSchema = z
  .object({
    authorized: z.literal("OK"),
    userkey: z.string(),
  })
  .openapi("KosyncAuthResponse");

const KosyncProgressResponseSchema = z
  .object({
    document: z.string(),
    progress: z.string(),
    percentage: z.number(),
    device: z.string(),
    device_id: z.string().optional(),
    timestamp: z.number(),
  })
  .openapi("KosyncProgressResponse");

// ── GET /users/auth ──────────────────────────────────────────────

const getAuthRoute = createRoute({
  method: "get",
  path: "/users/auth",
  tags: ["kosync"],
  summary: "Authenticate via KOReader headers",
  description:
    "KOReader sends credentials via `x-auth-user` (username) and `x-auth-key` (md5-hashed password) headers. Returns the userkey for subsequent sync requests. These non-standard headers are validated in the handler.",
  responses: {
    200: {
      description: "Authentication successful",
      content: {
        "application/json": {
          schema: KosyncAuthResponseSchema,
        },
      },
    },
    401: { description: "Missing or invalid credentials" },
  },
});

// ── POST /users/auth ─────────────────────────────────────────────

const postAuthRoute = createRoute({
  method: "post",
  path: "/users/auth",
  tags: ["kosync"],
  summary: "Authenticate via JSON body",
  description:
    "Validate KoSync credentials provided as a JSON body. Returns the md5-hashed password as the userkey for subsequent sync requests.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: KosyncAuthBody,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authentication successful",
      content: {
        "application/json": {
          schema: KosyncAuthResponseSchema,
        },
      },
    },
    400: { description: "Invalid request body" },
    401: { description: "Invalid credentials" },
  },
});

// ── POST /users/create ───────────────────────────────────────────

const postCreateRoute = createRoute({
  method: "post",
  path: "/users/create",
  tags: ["kosync"],
  summary: "Register a KoSync user (disabled)",
  description:
    "KOReader calls this endpoint to register a new user. Registration is disabled in Libris — credentials must be set via the Libris dashboard. Always returns 409.",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            username: z.string().optional(),
            password: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    409: { description: "Registration is disabled; set credentials in the Libris dashboard" },
  },
});

// ── GET /syncs/progress/:document ───────────────────────────────

const getProgressRoute = createRoute({
  method: "get",
  path: "/syncs/progress/{document}",
  tags: ["kosync"],
  summary: "Get reading progress",
  description:
    "Retrieve the most recent reading progress entry for a document identified by its hash. Returns 404 if no progress has been recorded for this document.",
  request: {
    params: z.object({
      document: z.string().min(1).openapi({ description: "Document hash (content or original)" }),
    }),
  },
  responses: {
    200: {
      description: "Reading progress",
      content: {
        "application/json": {
          schema: KosyncProgressResponseSchema,
        },
      },
    },
    404: { description: "No progress found for this document" },
  },
});

// ── PUT /syncs/progress ──────────────────────────────────────────

const putProgressRoute = createRoute({
  method: "put",
  path: "/syncs/progress",
  tags: ["kosync"],
  summary: "Upsert reading progress",
  description:
    "Create or update reading progress for a document/device pair. Also appends to the progress history table (fire-and-forget). Returns the persisted progress entry.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: KosyncProgressBody,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Persisted reading progress",
      content: {
        "application/json": {
          schema: KosyncProgressResponseSchema,
        },
      },
    },
    400: { description: "Invalid request body" },
  },
});

// ── Router ───────────────────────────────────────────────────────

export const kosyncRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  // GET /users/auth — KOReader sends md5(password) via x-auth-user / x-auth-key headers
  .openapi(getAuthRoute, async (c) => {
    const username = c.req.header("x-auth-user");
    const password = c.req.header("x-auth-key");
    if (!username || !password) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = c.get("db");

    await validateKosyncCredentials(username, password, db);

    // Return the key as userkey — KOReader stores this for subsequent sync requests
    return c.json({ authorized: "OK", userkey: password } satisfies KosyncAuthResponse);
  })

  // POST /users/auth — validate credentials from JSON body
  .openapi(postAuthRoute, async (c) => {
    const body = c.req.valid("json");
    const db = c.get("db");

    // The body form carries the PLAINTEXT password — this is the one-time
    // exchange where a client trades it for the userkey it will send from then
    // on. The stored secret is the md5 digest, so hash here rather than in the
    // validator: everywhere else the value arriving is already the digest, and
    // a validator that accepted both would restore the two-valid-secrets bug
    // this slice removed.
    const userkey = md5(body.password);
    await validateKosyncCredentials(body.username, userkey, db);

    return c.json({ authorized: "OK", userkey } satisfies KosyncAuthResponse);
  })

  // POST /users/create — registration disabled, credentials are set via the dashboard
  .openapi(postCreateRoute, () => {
    // The body is deliberately never read. Parsing it bought nothing — the
    // answer is the same whatever KOReader sends — and a bodyless POST made
    // c.req.json() throw, turning a refusal into a 500.
    throw new HTTPException(409, {
      message: "Registration is disabled. Set KoSync credentials in the Libris dashboard.",
    });
  })

  // GET /syncs/progress/:document — get progress by document hash
  .openapi(getProgressRoute, async (c) => {
    const { document } = c.req.valid("param");
    const db = c.get("db");
    const userId = c.get("userId");
    if (!userId) throw new HTTPException(401, { message: "Unauthorized" });

    const result = await db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.document, document), eq(readingProgress.userId, userId)))
      .orderBy(desc(readingProgress.timestamp))
      .limit(1);

    if (result.length === 0) {
      throw new HTTPException(404, { message: "Not found" });
    }

    const row = result[0]!;
    return c.json({
      document: row.document,
      progress: row.progress,
      percentage: Number(row.percentage),
      device: row.device,
      device_id: row.deviceId ?? undefined,
      timestamp: Number(row.timestamp),
    } satisfies KosyncProgressResponse);
  })

  // PUT /syncs/progress — upsert reading progress
  .openapi(putProgressRoute, async (c) => {
    const body = c.req.valid("json");
    const db = c.get("db");
    const userId = getUserId(c);
    const now = Math.floor(Date.now() / 1000);

    // Resolve book_id from document hash — enables direct joins without OR condition
    const bookId = await resolveBookIdForDocument(db, body.document);

    const [result] = await db
      .insert(readingProgress)
      .values({
        bookId,
        userId,
        document: body.document,
        progress: body.progress,
        percentage: String(body.percentage ?? 0),
        device: body.device,
        deviceId: body.device_id,
        timestamp: BigInt(now),
        rawPayload: body,
      })
      .onConflictDoUpdate({
        target: [readingProgress.userId, readingProgress.document, readingProgress.device],
        set: {
          bookId,
          progress: body.progress,
          percentage: String(body.percentage ?? 0),
          deviceId: body.device_id,
          timestamp: BigInt(now),
          rawPayload: body,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Append to history (fire-and-forget, don't block the response)
    void db
      .insert(readingProgressHistory)
      .values({
        bookId,
        userId,
        document: body.document,
        device: body.device,
        progress: body.progress,
        percentage: String(body.percentage ?? 0),
        timestamp: BigInt(now),
      })
      .catch((err) =>
        logger
          .withMetadata({ error: String(err) })
          .warn("Failed to append reading progress history"),
      );

    // Update per-(user, book) lifecycle aggregate. Fire-and-forget so a slow
    // aggregate write never blocks the kosync response. COALESCE semantics
    // inside upsertReadingAggregate ensure existing values are never clobbered.
    if (bookId !== null) {
      void upsertReadingAggregate(db, userId, bookId, body.document).catch((err) =>
        logger
          .withMetadata({ error: String(err), bookId, document: body.document })
          .warn("Failed to upsert reading aggregate"),
      );
    }

    return c.json({
      document: result!.document,
      progress: result!.progress,
      percentage: Number(result!.percentage),
      device: result!.device,
      device_id: result!.deviceId ?? undefined,
      timestamp: Number(result!.timestamp),
    } satisfies KosyncProgressResponse);
  });
