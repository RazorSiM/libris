import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  appSettings,
  bookMetadataCandidates,
  bookFiles,
  hardcoverSyncLog,
  readingProgress,
  readingProgressHistory,
  apiKeys,
  uploadRegistry,
  books,
  serviceCredentials,
  kosyncCredentials,
  sessions,
  accounts,
  verifications,
  users,
} from "#db";
import { asc, eq } from "drizzle-orm";
import type { AppVariables } from "../../context.js";

function assertTestEnv(env: { NODE_ENV: string; E2E_TEST: string }): void {
  if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development" && env.E2E_TEST !== "1") {
    throw new HTTPException(404, { message: "Not found" });
  }
}

export const testRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  /**
   * POST /cleanup — wipe test data.
   *
   * Content only by default. The E2E suite signs in once in a setup project
   * and reuses that storageState for every spec, so wiping accounts between
   * tests would log the whole run out — and the failure would surface three
   * specs later as an unexplained redirect to /login.
   *
   * Pass { includeAuth: true } for the handful of tests that need a genuinely
   * empty install, e.g. first-run setup.
   */
  .post("/cleanup", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const redisStorage = c.get("redisStorage");
    const { includeAuth = false } = await c.req
      .json<{ includeAuth?: boolean }>()
      .catch(() => ({ includeAuth: false }));

    // Delete in FK-safe order (children before parents)
    await db.delete(bookMetadataCandidates);
    await db.delete(bookFiles);
    await db.delete(hardcoverSyncLog);
    await db.delete(readingProgress);
    await db.delete(readingProgressHistory);
    await db.delete(uploadRegistry);
    // Before users: books.created_by is ON DELETE RESTRICT, so a users wipe
    // fails while any book survives.
    await db.delete(books);
    await db.delete(serviceCredentials);
    await db.delete(appSettings);

    if (includeAuth) {
      await db.delete(apiKeys);
      await db.delete(kosyncCredentials);
      await db.delete(sessions);
      await db.delete(accounts);
      await db.delete(verifications);
      await db.delete(users);
      // Better Auth keeps sessions here as well as in Postgres, so a wipe that
      // skipped it would leave a signed-in cookie working against a database
      // with no users in it.
      await redisStorage.clear();
    }

    return c.json({ ok: true });
  })

  // POST /seed-books — Insert books from body
  .post("/seed-books", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const body = await c.req.json<{
      createdBy?: string;
      books: Array<{
        title?: string;
        author?: string;
        description?: string;
        genres?: string[];
        status?: "inbox" | "review" | "organized";
        createdBy?: string;
      }>;
    }>();

    // books.created_by is NOT NULL since the cutover, so seeded books need an
    // owner. A test that cares which user owns what passes createdBy; the rest
    // get the oldest admin, matching the ingestion worker's fallback.
    const [defaultOwner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .orderBy(asc(users.createdAt))
      .limit(1);
    const fallbackOwner = body.createdBy ?? defaultOwner?.id;
    if (!fallbackOwner) {
      throw new HTTPException(400, {
        message: "No admin exists to own the seeded books; pass createdBy or seed a user first",
      });
    }

    const inserted = await db
      .insert(books)
      .values(
        body.books.map((b) => ({
          title: b.title ?? null,
          author: b.author ?? null,
          description: b.description ?? null,
          genres: b.genres ?? [],
          status: b.status ?? ("organized" as const),
          createdBy: b.createdBy ?? fallbackOwner,
        })),
      )
      .returning({ id: books.id, title: books.title });

    return c.json({ inserted });
  })

  // POST /seed-candidates — Insert metadata candidates from body
  .post("/seed-candidates", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const body = await c.req.json<{
      candidates: Array<{
        bookId: string;
        source: string;
        normalized?: Record<string, unknown>;
        confidence?: string;
      }>;
    }>();

    const inserted = await db
      .insert(bookMetadataCandidates)
      .values(
        body.candidates.map((candidate) => ({
          bookId: candidate.bookId,
          source: candidate.source,
          normalized: candidate.normalized ?? {},
          confidence: candidate.confidence ?? "0.5",
        })),
      )
      .returning({
        id: bookMetadataCandidates.id,
        bookId: bookMetadataCandidates.bookId,
        source: bookMetadataCandidates.source,
      });

    return c.json({ inserted });
  })

  // POST /seed-files — Insert book file records from body
  .post("/seed-files", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const body = await c.req.json<{
      files: Array<{
        bookId: string;
        format: string;
        originalName: string;
        storagePath?: string;
        fileSize?: number;
        contentHash?: string;
        originalContentHash?: string;
      }>;
    }>();

    const inserted = await db
      .insert(bookFiles)
      .values(
        body.files.map((f) => ({
          bookId: f.bookId,
          format: f.format,
          originalName: f.originalName,
          storagePath: f.storagePath ?? null,
          fileSize: f.fileSize ?? 0,
          contentHash: f.contentHash ?? null,
          originalContentHash: f.originalContentHash ?? null,
        })),
      )
      .returning({
        id: bookFiles.id,
        bookId: bookFiles.bookId,
        format: bookFiles.format,
      });

    return c.json({ inserted });
  })

  // POST /invalidate-cache — Clear all cache keys
  .post("/invalidate-cache", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const cacheStorage = c.get("cacheStorage");
    const keys = await cacheStorage.getKeys();
    await Promise.all(keys.map((key) => cacheStorage.removeItem(key)));

    return c.json({ cleared: keys.length });
  })

  // POST /emit-event — Fire a server event through the event bus (for WebSocket testing)
  .post("/emit-event", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const body = await c.req.json<{
      type: string;
      bookId?: string;
      payload?: Record<string, unknown>;
    }>();

    const { publishEvent } = await import("../../services/event-bus.js");
    await publishEvent({
      type: body.type,
      bookId: body.bookId,
      payload: body.payload,
    });

    return c.json({ ok: true });
  });
