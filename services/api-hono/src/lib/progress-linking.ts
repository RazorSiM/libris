import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { bookFiles, readingProgress, readingProgressHistory } from "#db";
import type { Db } from "#db";
// Relative, not "#db/rows": see the note in lib/reading-status.ts.
import { rowCount } from "../db/rows.js";

/**
 * Resolve the book a KoReader `document` hash belongs to by matching it against
 * the stored file hashes. A file's bytes change when Libris re-embeds metadata,
 * so both the current `content_hash` and the pre-embed `original_content_hash`
 * are checked. Returns null when no file matches (e.g. a sideloaded copy whose
 * bytes differ from the library's, or progress that arrived before the book was
 * organized).
 */
export async function resolveBookIdForDocument(db: Db, document: string): Promise<string | null> {
  const [match] = await db
    .select({ bookId: bookFiles.bookId })
    .from(bookFiles)
    .where(or(eq(bookFiles.contentHash, document), eq(bookFiles.originalContentHash, document)))
    .limit(1);
  return match?.bookId ?? null;
}

/**
 * Link orphaned reading_progress / reading_progress_history rows (book_id IS
 * NULL) to `bookId` when their `document` matches one of `hashes`. Idempotent.
 * Returns the number of reading_progress rows linked.
 *
 * Called from the organize pipeline whenever a file's content hash is computed
 * or changes. Without this, progress a device pushed *before* the book was
 * organized (so the document didn't resolve to a book yet) stays orphaned
 * forever and is invisible to Hardcover sync and the library's status views.
 */
export async function linkOrphanProgressForBook(
  db: Db,
  bookId: string,
  hashes: (string | null | undefined)[],
): Promise<number> {
  const docs = [...new Set(hashes.filter((h): h is string => Boolean(h)))];
  if (docs.length === 0) return 0;

  const linked = await db
    .update(readingProgress)
    .set({ bookId })
    .where(and(isNull(readingProgress.bookId), inArray(readingProgress.document, docs)))
    .returning({ id: readingProgress.id });

  await db
    .update(readingProgressHistory)
    .set({ bookId })
    .where(
      and(isNull(readingProgressHistory.bookId), inArray(readingProgressHistory.document, docs)),
    );

  return linked.length;
}

/**
 * Global reconcile: link every orphaned reading_progress / history row whose
 * `document` now matches some book_files hash. Cheap and idempotent — run once
 * as a maintenance job to recover rows orphaned before per-book linking existed.
 * Returns how many rows were linked in each table.
 */
export async function reconcileOrphanProgressBookIds(
  db: Db,
): Promise<{ progress: number; history: number }> {
  const progress = await db.execute(sql`
    UPDATE ${readingProgress} AS rp
    SET book_id = bf.book_id
    FROM ${bookFiles} AS bf
    WHERE rp.book_id IS NULL
      AND (rp.document = bf.content_hash OR rp.document = bf.original_content_hash)
    RETURNING rp.id
  `);
  const history = await db.execute(sql`
    UPDATE ${readingProgressHistory} AS rph
    SET book_id = bf.book_id
    FROM ${bookFiles} AS bf
    WHERE rph.book_id IS NULL
      AND (rph.document = bf.content_hash OR rph.document = bf.original_content_hash)
    RETURNING rph.id
  `);
  return { progress: rowCount(progress), history: rowCount(history) };
}
