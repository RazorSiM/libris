import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { sql } from "drizzle-orm";
import { books, readingAggregate, readingProgress, readingProgressHistory } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId } from "../../shared/auth.js";
import { FINISHED_THRESHOLD, PAUSED_DAYS } from "../../lib/reading-status.js";
import { cachedRoute } from "../../middleware/cache.js";

// ── Schemas ─────────────────────────────────────────────────────

const StatsResponseSchema = z.object({
  booksFinished: z.object({
    allTime: z.number().int(),
    thisYear: z.number().int(),
    thisMonth: z.number().int(),
  }),
  genreDistribution: z.array(
    z.object({
      genre: z.string(),
      count: z.number().int(),
    }),
  ),
  streak: z.object({
    current: z.number().int(),
    longest: z.number().int(),
  }),
  avgDaysToFinish: z.number().int(),
  pagesHeatmap: z
    .object({
      year: z.number().int(),
      days: z.array(
        z.object({
          day: z.string(),
          pages: z.number().int(),
        }),
      ),
    })
    .openapi({ description: "Daily pages read for the requested calendar year" }),
  finishedPerMonth: z
    .array(
      z.object({
        month: z.string(),
        count: z.number().int(),
      }),
    )
    .openapi({
      description: "Books finished per month of the current calendar year (12 entries)",
    }),
  readingVelocity: z
    .array(
      z.object({
        day: z.string(),
        avgPages: z.number(),
      }),
    )
    .openapi({
      description: "Trailing 7-day moving average of pages read per day over the last 90 days",
    }),
  topAuthors: z
    .array(
      z.object({
        author: z.string(),
        count: z.number().int(),
      }),
    )
    .openapi({ description: "Top 10 authors by organized-book count" }),
  daysToFinishBuckets: z
    .array(
      z.object({
        bucket: z.string(),
        count: z.number().int(),
      }),
    )
    .openapi({ description: "Histogram of days-to-finish across finished books, fixed buckets" }),
  libraryGrowth: z
    .array(
      z.object({
        month: z.string(),
        cumulative: z.number().int(),
      }),
    )
    .openapi({ description: "Cumulative library size by month since the first book was added" }),
});

const QuerySchema = z.object({
  year: z.coerce.number().int().min(1970).max(2100).optional().openapi({
    description: "Calendar year for the daily-pages heatmap (YYYY). Defaults to the current year.",
    example: 2026,
  }),
});

// ── Route ────────────────────────────────────────────────────────

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["stats"],
  summary: "Get reading statistics",
  description:
    "Returns reading analytics for the stats page: finished-book counts, genre distribution, reading streak, average finish time, yearly pages-read heatmap, books finished per month, reading velocity (7-day moving avg), top authors, days-to-finish histogram, and library growth.",
  request: {
    query: QuerySchema,
  },
  responses: {
    200: {
      description: "Reading statistics",
      content: {
        "application/json": {
          schema: StatsResponseSchema,
        },
      },
    },
  },
});

// ── Router ───────────────────────────────────────────────────────

const router = createOpenApiRouter<{ Variables: AppVariables }>();
router.use("/", cachedRoute({ maxAge: 60 }));

/**
 * Normalizes Drizzle `db.execute()` return shape across drivers.
 * - postgres-js resolves to an array-like RowList (supports `.map`, `[i]`).
 * - PGlite (used in unit tests) resolves to a `Results` object with a `.rows`
 *   array. Without this helper, chart CTEs hit `.map is not a function` in
 *   tests while working in production.
 */
function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] } | T[];
  if (Array.isArray(r)) return r;
  if (r && typeof r === "object" && Array.isArray(r.rows)) return r.rows;
  return Array.from(r as Iterable<T>);
}

/**
 * SQL CTEs that derive per-book effective reading status for a single user,
 * mirroring the precedence used in `lib/reading-status.ts` and
 * `lib/progress-aggregate.ts`:
 *
 *   manual_status
 *   ?? (any kosync activity ? computed : null)
 *   ?? external_status (Hardcover-pulled)
 *   ?? "unread"
 *
 * Exposes columns:
 *   book_state(book_id, genres, author, effective_status, finished_at, started_at)
 *
 * `finished_at` and `started_at` are derived using:
 *   finished_at = manual_finished_at ?? (kosync last_activity when finished by progress) ?? NULL
 *   started_at  = manual_started_at  ?? kosync first_activity ?? NULL
 *
 * External-only finished books therefore have `finished_at = NULL` (we don't
 * know when the user finished them on Hardcover); they count toward all-time
 * totals but are excluded from date-bucketed metrics, which is the right
 * default until/unless we start syncing read entries from Hardcover.
 */
function bookStateCte(userId: string) {
  return sql`
    user_progress AS (
      SELECT
        rp.book_id,
        MAX(CAST(rp.percentage AS numeric)) AS max_percentage
      FROM ${readingProgress} rp
      WHERE rp.user_id = ${userId} AND rp.book_id IS NOT NULL
      GROUP BY rp.book_id
    ),
    user_history AS (
      SELECT
        rph.book_id,
        MIN(rph.created_at) AS first_activity,
        MAX(rph.created_at) AS last_activity
      FROM ${readingProgressHistory} rph
      WHERE rph.user_id = ${userId} AND rph.book_id IS NOT NULL
      GROUP BY rph.book_id
    ),
    book_state AS (
      SELECT
        b.id AS book_id,
        b.genres,
        b.author,
        COALESCE(
          ra.manual_status::text,
          CASE
            WHEN up.max_percentage IS NULL OR up.max_percentage = 0 THEN NULL
            WHEN up.max_percentage >= ${FINISHED_THRESHOLD} THEN 'finished'
            WHEN uh.last_activity IS NULL THEN 'paused'
            WHEN uh.last_activity < NOW() - INTERVAL '1 day' * ${PAUSED_DAYS} THEN 'paused'
            ELSE 'reading'
          END,
          ra.external_status::text,
          'unread'
        ) AS effective_status,
        COALESCE(
          ra.manual_finished_at,
          CASE
            WHEN up.max_percentage IS NOT NULL AND up.max_percentage >= ${FINISHED_THRESHOLD}
              THEN uh.last_activity
          END
        ) AS finished_at,
        COALESCE(ra.manual_started_at, uh.first_activity) AS started_at
      FROM ${books} b
      LEFT JOIN user_progress up ON up.book_id = b.id
      LEFT JOIN user_history uh ON uh.book_id = b.id
      LEFT JOIN ${readingAggregate} ra
        ON ra.book_id = b.id AND ra.user_id = ${userId}
      WHERE b.status = 'organized'
    )
  `;
}

export const statsRoutes = router.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const userId = getUserId(c);

  const { year: yearParam } = c.req.valid("query");
  const now = new Date();
  const heatmapYear = yearParam ?? now.getFullYear();
  const startOfYear = new Date(now.getFullYear(), 0, 1).toISOString();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const heatmapYearStart = `${heatmapYear}-01-01`;
  const heatmapYearEnd = `${heatmapYear + 1}-01-01`;

  const [
    booksFinishedResult,
    genreDistributionResult,
    streakResult,
    avgFinishTimeResult,
    pagesHeatmapResult,
    finishedPerMonthResult,
    readingVelocityResult,
    topAuthorsResult,
    daysToFinishBucketsResult,
    libraryGrowthResult,
  ] = await Promise.all([
    // Books finished counts (all-time / this year / this month). All-time
    // includes manual + Hardcover-only finished books; year/month require a
    // known finish date so external-only (no kosync, no manual date) is
    // excluded from those buckets.
    db.execute<{ all_time: string; this_year: string; this_month: string }>(sql`
      WITH ${bookStateCte(userId)}
      SELECT
        COUNT(*) FILTER (WHERE effective_status = 'finished')::text AS all_time,
        COUNT(*) FILTER (
          WHERE effective_status = 'finished' AND finished_at >= ${startOfYear}
        )::text AS this_year,
        COUNT(*) FILTER (
          WHERE effective_status = 'finished' AND finished_at >= ${startOfMonth}
        )::text AS this_month
      FROM book_state
    `),

    // Genre distribution of finished books (top 10). Includes manual + Hardcover.
    db.execute<{ genre: string; count: string }>(sql`
      WITH ${bookStateCte(userId)}
      SELECT g AS genre, COUNT(*)::text AS count
      FROM book_state, unnest(book_state.genres) AS g
      WHERE effective_status = 'finished' AND array_length(book_state.genres, 1) > 0
      GROUP BY g
      ORDER BY count DESC
      LIMIT 10
    `),

    // Reading streak — consecutive days with history activity
    db.execute<{ current_streak: string; longest_streak: string }>(sql`
      WITH active_days AS (
        SELECT DISTINCT DATE(created_at) AS day
        FROM ${readingProgressHistory}
        WHERE user_id = ${userId}
        ORDER BY day
      ),
      day_groups AS (
        SELECT
          day,
          day - (ROW_NUMBER() OVER (ORDER BY day))::int * INTERVAL '1 day' AS grp
        FROM active_days
      ),
      streaks AS (
        SELECT grp, COUNT(*) AS streak_length, MAX(day) AS last_day
        FROM day_groups
        GROUP BY grp
      )
      SELECT
        COALESCE(
          (SELECT streak_length FROM streaks WHERE last_day >= CURRENT_DATE - INTERVAL '1 day' ORDER BY last_day DESC LIMIT 1),
          0
        )::text AS current_streak,
        COALESCE(MAX(streak_length), 0)::text AS longest_streak
      FROM streaks
    `),

    // Average days to finish (finished books only). Considers any finished
    // book with both a started_at and finished_at — kosync-derived or manual.
    // External-only books contribute neither and are skipped.
    db.execute<{ avg_days: string }>(sql`
      WITH ${bookStateCte(userId)}
      SELECT COALESCE(
        ROUND(AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) / 86400))::text,
        '0'
      ) AS avg_days
      FROM book_state
      WHERE effective_status = 'finished'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND finished_at > started_at
    `),

    // Pages-read heatmap for the requested calendar year
    db.execute<{ day: string; pages: string }>(sql`
      WITH deltas AS (
        SELECT
          DATE(rph.created_at) AS day,
          GREATEST(0,
            CAST(rph.percentage AS numeric) -
            COALESCE(
              LAG(CAST(rph.percentage AS numeric)) OVER (
                PARTITION BY rph.document, rph.device
                ORDER BY rph.created_at
              ),
              0
            )
          ) * COALESCE(b.page_count, 0) AS page_delta
        FROM ${readingProgressHistory} rph
        INNER JOIN ${books} b ON b.id = rph.book_id
        WHERE rph.user_id = ${userId}
          AND rph.created_at >= ${heatmapYearStart}::date
          AND rph.created_at < ${heatmapYearEnd}::date
      )
      SELECT day::text, ROUND(SUM(page_delta))::text AS pages
      FROM deltas
      GROUP BY day
      HAVING ROUND(SUM(page_delta)) > 0
      ORDER BY day
    `),

    // Books finished per month for the current calendar year (all 12 months).
    // External-only books are excluded — we have no Hardcover finish date.
    db.execute<{ month: string; count: string }>(sql`
      WITH ${bookStateCte(userId)},
      months AS (
        SELECT generate_series(
          DATE_TRUNC('year', CURRENT_DATE),
          DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '11 months',
          INTERVAL '1 month'
        ) AS month
      ),
      finished AS (
        SELECT book_id, finished_at
        FROM book_state
        WHERE effective_status = 'finished'
          AND finished_at IS NOT NULL
          AND finished_at >= DATE_TRUNC('year', CURRENT_DATE)
      )
      SELECT
        TO_CHAR(m.month, 'YYYY-MM') AS month,
        COUNT(f.book_id)::text AS count
      FROM months m
      LEFT JOIN finished f ON DATE_TRUNC('month', f.finished_at) = m.month
      GROUP BY m.month
      ORDER BY m.month
    `),

    // Reading velocity — 7-day moving avg of pages/day for the last 90 days
    db.execute<{ day: string; avg_pages: string }>(sql`
      WITH deltas AS (
        SELECT
          DATE(rph.created_at) AS day,
          GREATEST(0,
            CAST(rph.percentage AS numeric) -
            COALESCE(
              LAG(CAST(rph.percentage AS numeric)) OVER (
                PARTITION BY rph.document, rph.device
                ORDER BY rph.created_at
              ),
              0
            )
          ) * COALESCE(b.page_count, 0) AS page_delta
        FROM ${readingProgressHistory} rph
        INNER JOIN ${books} b ON b.id = rph.book_id
        WHERE rph.user_id = ${userId}
          AND rph.created_at >= NOW() - INTERVAL '97 days'
      ),
      daily AS (
        SELECT day, SUM(page_delta) AS pages
        FROM deltas
        GROUP BY day
      ),
      windowed AS (
        SELECT
          day,
          AVG(pages) OVER (
            ORDER BY day
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
          ) AS avg_pages
        FROM daily
      )
      SELECT day::text, ROUND(avg_pages::numeric, 1)::text AS avg_pages
      FROM windowed
      WHERE day >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY day
    `),

    // Top 10 authors by organized-book count
    db.execute<{ author: string; count: string }>(sql`
      SELECT
        COALESCE(NULLIF(TRIM(author), ''), 'Unknown') AS author,
        COUNT(*)::text AS count
      FROM ${books}
      WHERE status = 'organized'
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1 ASC
      LIMIT 10
    `),

    // Days-to-finish histogram (fixed 6 buckets, always all 6 rows). Uses any
    // finished book with a known span — kosync-derived or manual. External-only
    // books are skipped (no known dates).
    db.execute<{ bucket: string; sort_order: string; count: string }>(sql`
      WITH ${bookStateCte(userId)},
      bucket_defs AS (
        SELECT 1 AS sort_order, '0-7' AS bucket
        UNION ALL SELECT 2, '8-14'
        UNION ALL SELECT 3, '15-30'
        UNION ALL SELECT 4, '31-60'
        UNION ALL SELECT 5, '61-90'
        UNION ALL SELECT 6, '91+'
      ),
      spans AS (
        SELECT EXTRACT(EPOCH FROM (finished_at - started_at)) / 86400 AS days
        FROM book_state
        WHERE effective_status = 'finished'
          AND started_at IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > started_at
      ),
      counts AS (
        SELECT
          CASE
            WHEN days <= 7 THEN 1
            WHEN days <= 14 THEN 2
            WHEN days <= 30 THEN 3
            WHEN days <= 60 THEN 4
            WHEN days <= 90 THEN 5
            ELSE 6
          END AS sort_order,
          COUNT(*)::int AS count
        FROM spans
        GROUP BY 1
      )
      SELECT bd.bucket, bd.sort_order::text, COALESCE(c.count, 0)::text AS count
      FROM bucket_defs bd
      LEFT JOIN counts c ON c.sort_order = bd.sort_order
      ORDER BY bd.sort_order
    `),

    // Library growth — cumulative book count by month since the first book
    db.execute<{ month: string; cumulative: string }>(sql`
      WITH added_per_month AS (
        SELECT
          DATE_TRUNC('month', created_at) AS month,
          COUNT(*)::int AS added
        FROM ${books}
        WHERE created_at IS NOT NULL
        GROUP BY DATE_TRUNC('month', created_at)
      )
      SELECT
        TO_CHAR(month, 'YYYY-MM') AS month,
        (SUM(added) OVER (ORDER BY month))::text AS cumulative
      FROM added_per_month
      ORDER BY month
    `),
  ]);

  const finished = rowsOf<{ all_time: string; this_year: string; this_month: string }>(
    booksFinishedResult,
  )[0];
  const streak = rowsOf<{ current_streak: string; longest_streak: string }>(streakResult)[0];
  const avgDays = rowsOf<{ avg_days: string }>(avgFinishTimeResult)[0];

  return c.json({
    booksFinished: {
      allTime: Number(finished?.all_time ?? 0),
      thisYear: Number(finished?.this_year ?? 0),
      thisMonth: Number(finished?.this_month ?? 0),
    },
    genreDistribution: rowsOf<{ genre: string; count: string }>(genreDistributionResult).map(
      (g) => ({ genre: g.genre, count: Number(g.count) }),
    ),
    streak: {
      current: Number(streak?.current_streak ?? 0),
      longest: Number(streak?.longest_streak ?? 0),
    },
    avgDaysToFinish: Number(avgDays?.avg_days ?? 0),
    pagesHeatmap: {
      year: heatmapYear,
      days: rowsOf<{ day: string; pages: string }>(pagesHeatmapResult).map((d) => ({
        day: d.day,
        pages: Number(d.pages),
      })),
    },
    finishedPerMonth: rowsOf<{ month: string; count: string }>(finishedPerMonthResult).map((m) => ({
      month: m.month,
      count: Number(m.count),
    })),
    readingVelocity: rowsOf<{ day: string; avg_pages: string }>(readingVelocityResult).map((r) => ({
      day: r.day,
      avgPages: Number(r.avg_pages),
    })),
    topAuthors: rowsOf<{ author: string; count: string }>(topAuthorsResult).map((a) => ({
      author: a.author,
      count: Number(a.count),
    })),
    daysToFinishBuckets: rowsOf<{ bucket: string; count: string }>(daysToFinishBucketsResult).map(
      (b) => ({ bucket: b.bucket, count: Number(b.count) }),
    ),
    libraryGrowth: rowsOf<{ month: string; cumulative: string }>(libraryGrowthResult).map((l) => ({
      month: l.month,
      cumulative: Number(l.cumulative),
    })),
  });
});
