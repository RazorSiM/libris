import { sql } from "drizzle-orm";
import { books, readingAggregate, readingProgress, readingProgressHistory } from "#db";
import type { Db } from "#db";

// ── Types & Constants ────────────────────────────────────────────

export type ReadingStatus = "unread" | "reading" | "finished" | "paused";

export const HARDCOVER_STATUS_MAP: Record<ReadingStatus, number> = {
  unread: 1, // Want to Read
  reading: 2, // Currently Reading
  finished: 3, // Read
  paused: 4, // Paused
};

export const FINISHED_THRESHOLD = 0.95;
export const PAUSED_DAYS = 30;

export interface BookWithProgress {
  id: string;
  title: string | null;
  author: string | null;
  coverPath: string | null;
  isbn13: string | null;
  isbn10: string | null;
  genres: string[];
  pageCount: number | null;
  percentage: number | null;
  device: string | null;
  lastReadAt: Date | null;
  readingStatus: ReadingStatus;
}

// ── Core Function ────────────────────────────────────────────────

export function computeReadingStatus(
  percentage: number | null,
  lastActivityAt: Date | null,
): ReadingStatus {
  if (percentage === null || percentage === 0) {
    return "unread";
  }

  if (percentage >= FINISHED_THRESHOLD) {
    return "finished";
  }

  if (lastActivityAt === null) {
    return "paused";
  }

  const now = new Date();
  const diffMs = now.getTime() - lastActivityAt.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > PAUSED_DAYS) {
    return "paused";
  }

  return "reading";
}

// ── Query Helpers ────────────────────────────────────────────────

export async function getReadingStatusCounts(
  db: Db,
  userId?: string,
): Promise<Record<ReadingStatus, number>> {
  const rpFilter = userId ? sql`AND rp.user_id = ${userId}` : sql``;
  const rphFilter = userId ? sql`AND rph.user_id = ${userId}` : sql``;

  const aggregateFilter = userId ? sql`AND ra.user_id = ${userId}` : sql``;

  const result = await db.execute<{
    reading_status: ReadingStatus;
    count: string;
  }>(sql`
    WITH book_progress AS (
      SELECT
        b.id AS book_id,
        MAX(CAST(rp.percentage AS numeric)) AS max_percentage,
        MAX(rph.created_at) AS last_activity
      FROM ${books} b
      LEFT JOIN ${readingProgress} rp ON rp.book_id = b.id ${rpFilter}
      LEFT JOIN ${readingProgressHistory} rph ON rph.book_id = b.id ${rphFilter}
      WHERE b.status = 'organized'
      GROUP BY b.id
    ),
    book_overrides AS (
      SELECT
        ra.book_id,
        MAX(ra.manual_status::text) AS manual_status,
        MAX(ra.external_status::text) AS external_status
      FROM ${readingAggregate} ra
      WHERE ra.book_id IS NOT NULL
        AND (ra.manual_status IS NOT NULL OR ra.external_status IS NOT NULL)
        ${aggregateFilter}
      GROUP BY ra.book_id
    ),
    statuses AS (
      SELECT
        bp.book_id,
        COALESCE(
          bo.manual_status,
          CASE
            WHEN bp.max_percentage IS NULL OR bp.max_percentage = 0 THEN NULL
            WHEN bp.max_percentage >= ${FINISHED_THRESHOLD} THEN 'finished'
            WHEN bp.last_activity IS NULL THEN 'paused'
            WHEN bp.last_activity < NOW() - INTERVAL '1 day' * ${PAUSED_DAYS} THEN 'paused'
            ELSE 'reading'
          END,
          bo.external_status,
          'unread'
        ) AS reading_status
      FROM book_progress bp
      LEFT JOIN book_overrides bo ON bo.book_id = bp.book_id
    )
    SELECT reading_status, COUNT(*)::text AS count
    FROM statuses
    GROUP BY reading_status
  `);

  const counts: Record<ReadingStatus, number> = {
    unread: 0,
    reading: 0,
    finished: 0,
    paused: 0,
  };

  for (const row of result as unknown as { reading_status: ReadingStatus; count: string }[]) {
    counts[row.reading_status] = Number(row.count);
  }

  return counts;
}

export async function getBooksByReadingStatus(
  db: Db,
  status: ReadingStatus,
  options: {
    page?: number;
    perPage?: number;
    sort?: "title" | "author" | "percentage" | "lastRead";
    order?: "asc" | "desc";
    search?: string;
    userId?: string;
  } = {},
): Promise<{ books: BookWithProgress[]; total: number }> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? 20;
  const sort = options.sort ?? "title";
  const order = options.order ?? "asc";
  const offset = (page - 1) * perPage;

  const sortColumn = {
    title: sql`f.title`,
    author: sql`f.author`,
    percentage: sql`f.max_percentage`,
    lastRead: sql`f.last_activity`,
  }[sort];

  const orderDir = order === "desc" ? sql`DESC NULLS LAST` : sql`ASC NULLS LAST`;

  const searchCondition = options.search
    ? sql`AND b.search_vector @@ plainto_tsquery('english', ${options.search})`
    : sql``;

  const searchRankSelect = options.search
    ? sql`, ts_rank(b.search_vector, plainto_tsquery('english', ${options.search})) AS search_rank`
    : sql``;

  const rpFilter = options.userId ? sql`AND rp.user_id = ${options.userId}` : sql``;
  const rphFilter = options.userId ? sql`AND rph.user_id = ${options.userId}` : sql``;
  const deviceFilter = options.userId ? sql`AND rp.user_id = ${options.userId}` : sql``;
  const aggregateFilter = options.userId ? sql`AND ra.user_id = ${options.userId}` : sql``;

  const result = await db.execute<{
    book_id: string;
    title: string | null;
    author: string | null;
    cover_path: string | null;
    isbn13: string | null;
    isbn10: string | null;
    genres: string[];
    page_count: number | null;
    max_percentage: string | null;
    device: string | null;
    last_activity: string | null;
    reading_status: ReadingStatus;
    total_count: string;
  }>(sql`
    WITH book_progress AS (
      SELECT
        b.id AS book_id,
        b.title,
        b.author,
        b.cover_path,
        b.isbn_13 AS isbn13,
        b.isbn_10 AS isbn10,
        b.genres,
        b.page_count,
        b.search_vector,
        MAX(CAST(rp.percentage AS numeric)) AS max_percentage,
        MAX(rph.created_at) AS last_activity
      FROM ${books} b
      LEFT JOIN ${readingProgress} rp ON rp.book_id = b.id ${rpFilter}
      LEFT JOIN ${readingProgressHistory} rph ON rph.book_id = b.id ${rphFilter}
      WHERE b.status = 'organized'
      ${searchCondition}
      GROUP BY b.id
    ),
    book_overrides AS (
      SELECT
        ra.book_id,
        MAX(ra.manual_status::text) AS manual_status,
        MAX(ra.external_status::text) AS external_status
      FROM ${readingAggregate} ra
      WHERE ra.book_id IS NOT NULL
        AND (ra.manual_status IS NOT NULL OR ra.external_status IS NOT NULL)
        ${aggregateFilter}
      GROUP BY ra.book_id
    ),
    with_status AS (
      SELECT
        book_progress.*
        ${searchRankSelect},
        COALESCE(
          bo.manual_status,
          CASE
            WHEN max_percentage IS NULL OR max_percentage = 0 THEN NULL
            WHEN max_percentage >= ${FINISHED_THRESHOLD} THEN 'finished'
            WHEN last_activity IS NULL THEN 'paused'
            WHEN last_activity < NOW() - INTERVAL '1 day' * ${PAUSED_DAYS} THEN 'paused'
            ELSE 'reading'
          END,
          bo.external_status,
          'unread'
        ) AS reading_status
      FROM book_progress
      LEFT JOIN book_overrides bo ON bo.book_id = book_progress.book_id
    ),
    filtered AS (
      SELECT * FROM with_status
      WHERE reading_status = ${status}
    ),
    device_info AS (
      SELECT DISTINCT ON (rp.book_id)
        rp.book_id,
        rp.device
      FROM ${readingProgress} rp
      WHERE rp.book_id IS NOT NULL ${deviceFilter}
      ORDER BY rp.book_id, rp.timestamp DESC
    )
    SELECT
      f.book_id,
      f.title,
      f.author,
      f.cover_path,
      f.isbn13,
      f.isbn10,
      f.genres,
      f.page_count,
      f.max_percentage::text AS max_percentage,
      di.device,
      f.last_activity::text AS last_activity,
      f.reading_status,
      COUNT(*) OVER()::text AS total_count
    FROM filtered f
    LEFT JOIN device_info di ON di.book_id = f.book_id
    ORDER BY ${sortColumn} ${orderDir}
    LIMIT ${perPage}
    OFFSET ${offset}
  `);

  const rows = result as unknown as {
    book_id: string;
    title: string | null;
    author: string | null;
    cover_path: string | null;
    isbn13: string | null;
    isbn10: string | null;
    genres: string[];
    page_count: number | null;
    max_percentage: string | null;
    device: string | null;
    last_activity: string | null;
    reading_status: ReadingStatus;
    total_count: string;
  }[];

  const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;

  const mappedBooks: BookWithProgress[] = rows.map((row) => ({
    id: row.book_id,
    title: row.title,
    author: row.author,
    coverPath: row.cover_path,
    isbn13: row.isbn13,
    isbn10: row.isbn10,
    genres: row.genres ?? [],
    pageCount: row.page_count,
    percentage: row.max_percentage !== null ? Number(row.max_percentage) : null,
    device: row.device,
    lastReadAt: row.last_activity !== null ? new Date(row.last_activity) : null,
    readingStatus: row.reading_status,
  }));

  return { books: mappedBooks, total };
}
