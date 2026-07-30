import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { books } from "#db";
import type { Db } from "#db";
import { findEditionByIsbn, getEditionPages } from "./client";
import { getLogger } from "../logger.js";

const log = getLogger("hardcover:matching");
const MAX_RATE_LIMIT_RETRIES = 5;

export interface MatchResult {
  matched: number;
  skipped: number;
  failed: number;
}

/**
 * Match local books to Hardcover editions via ISBN lookup.
 * Only processes organized books without a hardcover_book_id that have at least one ISBN.
 */
export async function matchBooksToHardcover(
  db: Db,
  token: string,
  options?: {
    onProgress?: (matched: number, total: number) => void;
    batchSize?: number;
  },
): Promise<MatchResult> {
  // Query books that need matching: organized, no hardcover ID, has at least one ISBN
  const unmatchedBooks = await db
    .select({
      id: books.id,
      isbn13: books.isbn13,
      isbn10: books.isbn10,
      title: books.title,
    })
    .from(books)
    .where(
      and(
        eq(books.status, "organized"),
        isNull(books.hardcoverBookId),
        or(isNotNull(books.isbn13), isNotNull(books.isbn10)),
      ),
    );

  if (unmatchedBooks.length === 0) {
    log.info("No unmatched books with ISBNs found");
    return { matched: 0, skipped: 0, failed: 0 };
  }

  log.info(`Found ${unmatchedBooks.length} unmatched books to process`);

  let matched = 0;
  let skipped = 0;
  let failed = 0;
  let rateLimitRetries = 0;

  for (let i = 0; i < unmatchedBooks.length; i++) {
    const book = unmatchedBooks[i];

    try {
      const result = await findEditionByIsbn(
        token,
        book.isbn13 ?? undefined,
        book.isbn10 ?? undefined,
      );

      if (!result.ok) {
        if (result.error.type === "rate_limited") {
          rateLimitRetries++;
          if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.error(
              `Rate limit retries exhausted (${MAX_RATE_LIMIT_RETRIES}) during ISBN matching, aborting`,
            );
            throw new Error(
              `Hardcover rate limit retries exhausted after ${MAX_RATE_LIMIT_RETRIES} attempts`,
            );
          }
          log.warn(
            `Rate limited (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), pausing for 60s...`,
          );
          await new Promise((r) => setTimeout(r, 60_000));
          i--; // Retry this book
          continue;
        }
        failed++;
        log.warn(`Failed to match "${book.title}": ${result.error.type}`);
        continue;
      }

      if (result.data === null) {
        skipped++;
        continue;
      }

      // Update book with Hardcover IDs, page count, and series data
      await db
        .update(books)
        .set({
          hardcoverBookId: result.data.bookId,
          hardcoverEditionId: result.data.editionId,
          ...(result.data.pages ? { pageCount: result.data.pages } : {}),
          ...(result.data.seriesName ? { series: result.data.seriesName } : {}),
          ...(result.data.seriesPosition != null
            ? { seriesIndex: result.data.seriesPosition }
            : {}),
        })
        .where(eq(books.id, book.id));

      matched++;
      log.info(
        `Matched "${book.title}" → book=${result.data.bookId}, edition=${result.data.editionId}`,
      );
    } catch (err) {
      failed++;
      log.withMetadata({ error: String(err) }).error(`Error matching "${book.title}"`);
    }

    // Reset per-book rate limit budget when moving to the next book.
    // The rate-limit retry path uses i--/continue and skips this reset,
    // so retries accumulate only within the same book.
    rateLimitRetries = 0;

    options?.onProgress?.(matched, unmatchedBooks.length);

    // Throttle: ~1 request per 1.1 seconds (safe under 60/min)
    if (i < unmatchedBooks.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  log.info(
    `Matching complete: ${matched} matched, ${skipped} skipped (no match), ${failed} failed`,
  );
  return { matched, skipped, failed };
}

/**
 * Backfill page_count from Hardcover edition data for already-matched books.
 * Only updates books where the local page_count differs from the edition's pages.
 */
export async function backfillEditionPageCounts(
  db: Db,
  token: string,
): Promise<{ updated: number; skipped: number; failed: number }> {
  const matchedBooks = await db
    .select({
      id: books.id,
      title: books.title,
      pageCount: books.pageCount,
      hardcoverEditionId: books.hardcoverEditionId,
    })
    .from(books)
    .where(and(eq(books.status, "organized"), isNotNull(books.hardcoverEditionId)));

  if (matchedBooks.length === 0) {
    log.info("No matched books to backfill page counts for");
    return { updated: 0, skipped: 0, failed: 0 };
  }

  log.info(`Backfilling page counts for ${matchedBooks.length} matched books`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let rateLimitRetries = 0;

  for (let i = 0; i < matchedBooks.length; i++) {
    const book = matchedBooks[i];
    if (!book.hardcoverEditionId) {
      skipped++;
      continue;
    }

    try {
      const result = await getEditionPages(token, book.hardcoverEditionId);

      if (!result.ok) {
        if (result.error.type === "rate_limited") {
          rateLimitRetries++;
          if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.error(
              `Rate limit retries exhausted (${MAX_RATE_LIMIT_RETRIES}) during page count backfill, aborting`,
            );
            throw new Error(
              `Hardcover rate limit retries exhausted after ${MAX_RATE_LIMIT_RETRIES} attempts`,
            );
          }
          log.warn(
            `Rate limited (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), pausing for 60s...`,
          );
          await new Promise((r) => setTimeout(r, 60_000));
          i--;
          continue;
        }
        failed++;
        continue;
      }

      if (result.data && result.data !== book.pageCount) {
        await db.update(books).set({ pageCount: result.data }).where(eq(books.id, book.id));
        log.info(`"${book.title}": page_count ${book.pageCount} → ${result.data}`);
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      log.withMetadata({ error: String(err) }).error(`Error backfilling "${book.title}"`);
    }

    // Reset per-book rate limit budget when moving to the next book
    rateLimitRetries = 0;

    // Throttle
    if (i < matchedBooks.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  log.info(
    `Page count backfill complete: ${updated} updated, ${skipped} skipped, ${failed} failed`,
  );
  return { updated, skipped, failed };
}
