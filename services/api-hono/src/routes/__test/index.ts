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
} from "#db";
import type { AppVariables } from "../../context.js";
import { clearAuthCaches } from "../../middleware/auth.js";

function assertTestEnv(env: { NODE_ENV: string; E2E_TEST: string }): void {
  if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development" && env.E2E_TEST !== "1") {
    throw new HTTPException(404, { message: "Not found" });
  }
}

export const testRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  // POST /cleanup — Delete all rows in FK-safe order, clear Redis storage
  .post("/cleanup", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const redisStorage = c.get("redisStorage");

    // Delete in FK-safe order (children before parents)
    await db.delete(bookMetadataCandidates);
    await db.delete(bookFiles);
    await db.delete(hardcoverSyncLog);
    await db.delete(readingProgress);
    await db.delete(readingProgressHistory);
    await db.delete(uploadRegistry);
    await db.delete(apiKeys);
    await db.delete(books);
    await db.delete(serviceCredentials);
    await db.delete(appSettings);

    // Clear rate-limit / session storage
    await redisStorage.clear();

    // Clear in-memory auth caches to prevent cross-test leakage
    clearAuthCaches();

    return c.json({ ok: true });
  })

  // POST /seed-books — Insert books from body
  .post("/seed-books", async (c) => {
    const env = c.get("env");
    assertTestEnv(env);

    const db = c.get("db");
    const body = await c.req.json<{
      books: Array<{
        title?: string;
        author?: string;
        description?: string;
        genres?: string[];
        status?: "inbox" | "review" | "organized";
      }>;
    }>();

    const inserted = await db
      .insert(books)
      .values(
        body.books.map((b) => ({
          title: b.title ?? null,
          author: b.author ?? null,
          description: b.description ?? null,
          genres: b.genres ?? [],
          status: b.status ?? ("organized" as const),
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
