import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, eq, or, sql, count, countDistinct, desc, sum, inArray } from "drizzle-orm";
import { books, bookFiles, readingProgress } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId } from "../../shared/auth.js";
import { FINISHED_THRESHOLD, PAUSED_DAYS } from "../../lib/reading-status.js";
import {
  collectQueueCounts,
  getPipelineQueues,
  type QueueCounts,
} from "../../services/queue-diagnostics.js";

// ── GET / ────────────────────────────────────────────────────────

const dashboardRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["dashboard"],
  summary: "Get dashboard data",
  description:
    "Returns currently reading books, recently added, inbox count, library stats, and pipeline status",
  responses: {
    200: {
      description: "Dashboard data",
      content: {
        "application/json": {
          schema: z.object({
            currentlyReading: z.array(
              z.object({
                id: z.string().uuid(),
                title: z.string().nullable(),
                author: z.string().nullable(),
                coverPath: z.string().nullable(),
                percentage: z.number(),
                device: z.string(),
                lastRead: z.number(),
              }),
            ),
            recentlyAdded: z.array(
              z.object({
                id: z.string().uuid(),
                title: z.string().nullable(),
                author: z.string().nullable(),
                coverPath: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            inboxCount: z.number().int(),
            stats: z.object({
              totalBooks: z.number().int(),
              totalAuthors: z.number().int(),
              topGenre: z.string().nullable(),
              totalFileSize: z.number(),
              processingCount: z.number().int(),
            }),
            pipeline: z.record(
              z.string(),
              z.object({
                waiting: z.number().int(),
                active: z.number().int(),
                completed: z.number().int(),
                failed: z.number().int(),
                delayed: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// ── Router ───────────────────────────────────────────────────────

export const dashboardRoutes = createOpenApiRouter<{ Variables: AppVariables }>().openapi(
  dashboardRoute,
  async (c) => {
    const db = c.get("db");
    const userId = getUserId(c);

    const [
      currentlyReadingRaw,
      recentlyAdded,
      inboxCountResult,
      statsResult,
      topGenreResult,
      totalFileSizeResult,
    ] = await Promise.all([
      // Currently reading: books with progress > 0%, not finished, and not paused
      db
        .select({
          id: books.id,
          title: books.title,
          author: books.author,
          coverPath: books.coverPath,
          percentage: readingProgress.percentage,
          device: readingProgress.device,
          timestamp: readingProgress.timestamp,
        })
        .from(readingProgress)
        .innerJoin(
          bookFiles,
          or(
            eq(readingProgress.document, bookFiles.contentHash),
            eq(readingProgress.document, bookFiles.originalContentHash),
          ),
        )
        .innerJoin(books, eq(bookFiles.bookId, books.id))
        .where(
          and(
            eq(readingProgress.userId, userId),
            sql`${books.status} = 'organized'
              AND cast(${readingProgress.percentage} as numeric) > 0
              AND cast(${readingProgress.percentage} as numeric) < ${FINISHED_THRESHOLD}
              AND ${readingProgress.updatedAt} >= NOW() - INTERVAL '1 day' * ${PAUSED_DAYS}`,
          ),
        )
        .orderBy(desc(readingProgress.timestamp)),

      // Recently added: last 5 organized books
      db
        .select({
          id: books.id,
          title: books.title,
          author: books.author,
          coverPath: books.coverPath,
          createdAt: books.createdAt,
        })
        .from(books)
        .where(eq(books.status, "organized"))
        .orderBy(desc(books.createdAt))
        .limit(5),

      // Inbox count (inbox + review status)
      db
        .select({ count: count() })
        .from(books)
        .where(inArray(books.status, ["inbox", "review"])),

      // Stats: total organized books + unique authors
      db
        .select({
          totalBooks: count(),
          totalAuthors: countDistinct(books.author),
        })
        .from(books)
        .where(eq(books.status, "organized")),

      // Most common genre
      db.execute<{ genre: string; cnt: string }>(sql`
        SELECT g AS genre, COUNT(*) AS cnt
        FROM books, unnest(genres) AS g
        WHERE status = 'organized' AND array_length(genres, 1) > 0
        GROUP BY g
        ORDER BY cnt DESC
        LIMIT 1
      `),

      // Total file size across all book files
      db.select({ total: sum(bookFiles.fileSize) }).from(bookFiles),
    ]);

    // Deduplicate currently reading: keep latest progress per book
    const bookProgressMap = new Map<string, (typeof currentlyReadingRaw)[0]>();
    for (const entry of currentlyReadingRaw) {
      if (!bookProgressMap.has(entry.id)) {
        bookProgressMap.set(entry.id, entry);
      }
    }

    const topGenre = (topGenreResult as unknown as { genre: string }[])[0]?.genre;

    // Get pipeline/queue status
    let pipeline: Record<string, Omit<QueueCounts, "paused">> = {};
    try {
      const counts = await collectQueueCounts(getPipelineQueues());
      pipeline = Object.fromEntries(
        Object.entries(counts).map(([name, queue]) => {
          const { paused: _, ...pipelineCounts } = queue;
          return [name, pipelineCounts];
        }),
      );
    } catch {
      // Redis may be unavailable — return empty pipeline
    }

    // Sum up active + waiting across all queues for "processing" stat
    let processingCount = 0;
    for (const counts of Object.values(pipeline)) {
      processingCount += (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0);
    }

    return c.json({
      currentlyReading: Array.from(bookProgressMap.values()).map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        coverPath: b.coverPath,
        percentage: Number(b.percentage),
        device: b.device,
        lastRead: Number(b.timestamp),
      })),
      recentlyAdded: recentlyAdded.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        coverPath: b.coverPath,
        createdAt: b.createdAt.toISOString(),
      })),
      inboxCount: inboxCountResult[0]?.count ?? 0,
      stats: {
        totalBooks: statsResult[0]?.totalBooks ?? 0,
        totalAuthors: statsResult[0]?.totalAuthors ?? 0,
        topGenre: topGenre ?? null,
        totalFileSize: Number(totalFileSizeResult[0]?.total ?? 0),
        processingCount,
      },
      pipeline,
    });
  },
);
