import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, eq, or, sql, count, countDistinct, desc, sum, inArray } from "drizzle-orm";
import { books, bookFiles, readingProgress } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin } from "../../shared/auth.js";
import { FINISHED_THRESHOLD, PAUSED_DAYS } from "../../lib/reading-status.js";
import {
  collectInFlightBookIds,
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
    "Returns currently reading books, recently added, inbox count, library stats, and pipeline status. `currentlyReading`, `inboxCount` and `stats.processingCount` are per-user (reading progress is private, and inbox/review books are pre-approval uploads); `recentlyAdded` and the rest of `stats` describe the shared organized library, so `stats.totalFileSize` counts only organized books' files. `pipeline` holds install-wide queue counts and is therefore admin-only: it is an empty object for everyone else. Admins receive the install-wide inbox count and processing count.",
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
            inboxCount: z
              .number()
              .int()
              .openapi({ description: "Books awaiting approval. Owner-scoped unless admin." }),
            stats: z.object({
              totalBooks: z.number().int(),
              totalAuthors: z.number().int(),
              topGenre: z.string().nullable(),
              totalFileSize: z.number().openapi({
                description:
                  "Bytes held by the files of organized books. Excludes inbox and review uploads, which are private to their owner.",
              }),
              processingCount: z.number().int().openapi({
                description:
                  "Books with a pipeline job in flight. Counts only the caller's own books; install-wide for admins.",
              }),
            }),
            pipeline: z
              .record(
                z.string(),
                z.object({
                  waiting: z.number().int(),
                  active: z.number().int(),
                  completed: z.number().int(),
                  failed: z.number().int(),
                  delayed: z.number().int(),
                }),
              )
              .openapi({
                description:
                  "Per-queue job counts for the whole install. Admin-only; an empty object for every other caller.",
              }),
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
    const callerIsAdmin = isAdmin(c);

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

      // Inbox count (inbox + review status).
      //
      // Inbox/review books are pre-approval uploads and are NOT shared, so this
      // has to use the same predicate as GET /api/inbox/count — otherwise the
      // home page reports other users' pending uploads while the sidebar badge
      // and /inbox itself, both owner-scoped, show none of them.
      db
        .select({ count: count() })
        .from(books)
        .where(
          callerIsAdmin
            ? inArray(books.status, ["inbox", "review"])
            : and(inArray(books.status, ["inbox", "review"]), eq(books.createdBy, userId)),
        ),

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

      // Total bytes held by the shared library.
      //
      // Scoped to organized books for everyone, admins included.
      // A bare sum over `book_files` included every user's inbox and review
      // uploads, so the home page quietly published the byte volume of other
      // people's pre-approval files. "Organized only" is also the reading that
      // makes the surrounding object coherent: `totalBooks` and `totalAuthors`
      // beside it already count organized rows, so bytes-per-book now means
      // something, and organized books are the shared half of the ownership
      // model, so nothing here is anyone's private business.
      db
        .select({ total: sum(bookFiles.fileSize) })
        .from(bookFiles)
        .innerJoin(books, eq(bookFiles.bookId, books.id))
        .where(eq(books.status, "organized")),
    ]);

    // Deduplicate currently reading: keep latest progress per book
    const bookProgressMap = new Map<string, (typeof currentlyReadingRaw)[0]>();
    for (const entry of currentlyReadingRaw) {
      if (!bookProgressMap.has(entry.id)) {
        bookProgressMap.set(entry.id, entry);
      }
    }

    const topGenre = (topGenreResult as unknown as { genre: string }[])[0]?.genre;

    // Pipeline and processing counts.
    //
    // Per-queue counts are a property of the install, not of a person: they
    // say how much work is in flight and how much of it has failed, across
    // everybody's uploads. A non-admin who reads `pipeline` learns that other
    // people's books are being processed and roughly how many, which is the
    // same disclosure the owner-scoped inbox count exists to prevent. So the
    // breakdown is admin-only, and a non-admin's `processingCount` is derived
    // the way /api/inbox/processing derives its map: from the book ids in
    // flight, intersected with the ones they own.
    let pipeline: Record<string, Omit<QueueCounts, "isPaused">> = {};
    let processingCount = 0;

    try {
      if (callerIsAdmin) {
        const counts = await collectQueueCounts(getPipelineQueues());
        pipeline = Object.fromEntries(
          Object.entries(counts).map(([name, queue]) => {
            const { isPaused: _, ...pipelineCounts } = queue;
            return [name, pipelineCounts];
          }),
        );
        for (const counts of Object.values(pipeline)) {
          processingCount += (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0);
        }
      } else {
        const inFlight = await collectInFlightBookIds(c.get("queues"));
        if (inFlight.length > 0) {
          const owned = await db
            .select({ count: count() })
            .from(books)
            .where(and(inArray(books.id, inFlight), eq(books.createdBy, userId)));
          processingCount = owned[0]?.count ?? 0;
        }
      }
    } catch {
      // Redis may be unavailable — report an empty pipeline and nothing in flight
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
