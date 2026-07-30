import { sql } from "drizzle-orm";
import {
  books,
  hardcoverSyncLog,
  readingAggregate,
  readingProgress,
  readingProgressHistory,
} from "#db";
import type { Db } from "#db";

export type SyncCandidateRow = {
  book_id: string;
  title: string | null;
  page_count: number | null;
  hardcover_book_id: number;
  hardcover_edition_id: number | null;
  max_percentage: string | null;
  first_activity: string | null;
  last_activity: string | null;
  manual_status: string | null;
  sync_id: string | null;
  last_status: string | null;
  last_progress: string | null;
  hardcover_user_book_id: number | null;
  hardcover_read_id: number | null;
};

/**
 * Find Hardcover-linked books that need to be pushed to Hardcover for the
 * given user. A book is a sync candidate when either
 *   (a) it has local progress data (max_percentage > 0), or
 *   (b) the user set a manual_status override on it,
 * AND the sync log is missing or its `last_status`/`last_progress` differ
 * from the current effective state.
 *
 * The effective status used in change detection is `manual_status ?? computed`,
 * so a manual override flips the change-detector even when no progress exists.
 */
export async function findBooksToSyncToHardcover(
  db: Db,
  apiKeyId: string,
): Promise<SyncCandidateRow[]> {
  const result = await db.execute<SyncCandidateRow>(sql`
    WITH book_progress AS (
      SELECT
        b.id AS book_id,
        b.title,
        b.page_count,
        b.hardcover_book_id,
        b.hardcover_edition_id,
        MAX(CAST(rp.percentage AS numeric)) AS max_percentage,
        MIN(rph.created_at) AS first_activity,
        MAX(rph.created_at) AS last_activity
      FROM ${books} b
      LEFT JOIN ${readingProgress} rp ON rp.book_id = b.id AND rp.api_key_id = ${apiKeyId}
      LEFT JOIN ${readingProgressHistory} rph ON rph.book_id = b.id AND rph.api_key_id = ${apiKeyId}
      WHERE b.status = 'organized'
        AND b.hardcover_book_id IS NOT NULL
      GROUP BY b.id
    ),
    book_override AS (
      SELECT
        ra.book_id,
        ra.manual_status::text AS manual_status
      FROM ${readingAggregate} ra
      WHERE ra.api_key_id = ${apiKeyId}
        AND ra.manual_status IS NOT NULL
    )
    SELECT
      bp.*,
      bo.manual_status,
      sl.id AS sync_id,
      sl.last_status,
      sl.last_progress,
      sl.hardcover_user_book_id,
      sl.hardcover_read_id
    FROM book_progress bp
    LEFT JOIN book_override bo ON bo.book_id = bp.book_id
    LEFT JOIN ${hardcoverSyncLog} sl ON sl.book_id = bp.book_id AND sl.api_key_id = ${apiKeyId}
    WHERE (
        (bp.max_percentage IS NOT NULL AND bp.max_percentage > 0)
        OR bo.manual_status IS NOT NULL
      )
      AND (sl.id IS NULL
      OR sl.last_status IS DISTINCT FROM COALESCE(
        bo.manual_status,
        CASE
          WHEN bp.max_percentage IS NULL OR bp.max_percentage = 0 THEN 'unread'
          WHEN bp.max_percentage >= 0.95 THEN 'finished'
          WHEN bp.last_activity IS NULL THEN 'paused'
          WHEN bp.last_activity < NOW() - INTERVAL '30 days' THEN 'paused'
          ELSE 'reading'
        END
      )
      OR ABS(COALESCE(CAST(sl.last_progress AS numeric), 0) - COALESCE(bp.max_percentage, 0)) > 0.001)
  `);

  // postgres-js returns rows array directly; PGlite (used in tests) wraps them
  // in { rows, fields }. Normalize so callers — and tests — see a plain array.
  const maybeWrapped = result as unknown as SyncCandidateRow[] | { rows: SyncCandidateRow[] };
  return Array.isArray(maybeWrapped) ? maybeWrapped : maybeWrapped.rows;
}
