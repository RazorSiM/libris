import { bookMetadataCandidates, books } from "#db";
import { getHardcoverTokenForUser, searchHardcover } from "../lib/metadata/index.js";
import { BookFetchMetadataPayloadSchema } from "../types/index.js";
import type { BookFetchMetadataPayload } from "../types/index.js";
import type { MetadataCandidate, MetadataSearchQuery } from "../types/index.js";
import type { Job } from "bullmq";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../services/db.js";
import { getCacheStorage } from "../services/cache-storage.js";
import { invalidateRouteCache } from "../services/cache.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("worker:book-fetch-metadata");

/**
 * Parse a search query string into structured MetadataSearchQuery.
 * Supports: "Title by Author", "isbn:1234567890", or plain title text.
 */
function parseSearchQuery(raw: string): MetadataSearchQuery {
  const query: MetadataSearchQuery = {};

  // Check for ISBN pattern
  const isbnMatch = raw.match(/\bisbn[:\s]*(\d{10}|\d{13})\b/i);
  if (isbnMatch) {
    query.isbn = isbnMatch[1];
  }

  // Strip the ISBN prefix before parsing title/author
  const cleaned = raw.replace(/\bisbn[:\s]*\d{10,13}\b\s*/i, "").trim();

  // Check for "Title by Author" pattern
  const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    query.title = byMatch[1].trim();
    query.author = byMatch[2].trim();
  } else if (cleaned) {
    query.title = cleaned;
  }

  return query;
}

/**
 * Check for potential duplicate books by ISBN-13 match or fuzzy title+author match.
 * Returns the ID of the first matching existing book, or null.
 */
async function findPossibleDuplicate(
  db: ReturnType<typeof getDb>,
  bookId: string,
  isbn13: string | null,
  title: string | null,
  author: string | null,
): Promise<string | null> {
  // Layer 1: Exact ISBN-13 match
  if (isbn13) {
    const [isbnMatch] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.isbn13, isbn13), ne(books.id, bookId)))
      .limit(1);
    if (isbnMatch) {
      logger.info(`Book ${bookId}: ISBN-13 duplicate found → ${isbnMatch.id}`);
      return isbnMatch.id;
    }
  }

  // Layer 2: Fuzzy title+author match using pg_trgm similarity
  if (title && author) {
    const [fuzzyMatch] = await db
      .select({ id: books.id })
      .from(books)
      .where(
        and(
          ne(books.id, bookId),
          sql`similarity(${books.title}, ${title}) > 0.7`,
          sql`similarity(${books.author}, ${author}) > 0.7`,
        ),
      )
      .limit(1);
    if (fuzzyMatch) {
      logger.info(`Book ${bookId}: fuzzy title+author duplicate found → ${fuzzyMatch.id}`);
      return fuzzyMatch.id;
    }
  }

  return null;
}

/**
 * Fetches metadata from external APIs for a book.
 *
 * Responsibilities:
 * - Query Hardcover for metadata
 * - Insert one book_metadata_candidates row per source
 * - Check for potential duplicates (ISBN + fuzzy matching)
 * - Set books.status = 'review'
 */
export async function processBookFetchMetadata(job: Job<BookFetchMetadataPayload>): Promise<void> {
  const { bookId, searchQuery, skipStatusChange } = BookFetchMetadataPayloadSchema.parse(job.data);
  logger.info(`Fetching metadata for book ${bookId}: "${searchQuery}"`);
  await job.log(`Fetching metadata for book ${bookId}: "${searchQuery}"`);

  const db = getDb();

  // 1. Verify book exists
  const book = await db.query.books.findFirst({
    where: { id: bookId },
  });

  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  if (book.status === "review" && !skipStatusChange) {
    logger.info(`Book ${bookId} already in review status, skipping`);
    await job.log(`Book ${bookId} already in review, skipping`);
    return;
  }

  // 2. Parse the search query and enrich with known book data
  const query = parseSearchQuery(searchQuery);
  if (!query.title && book.title) query.title = book.title;
  if (!query.author && book.author) query.author = book.author;
  if (!query.isbn && book.isbn13) query.isbn = book.isbn13;
  if (!query.isbn && book.isbn10) query.isbn = book.isbn10;

  // 3. Fetch from Hardcover
  const candidatesToInsert: { source: string; best: MetadataCandidate }[] = [];

  try {
    await job.log(`Searching Hardcover for: ${JSON.stringify(query)}`);
    // Spend the book owner's own token when they have one. Falling back to any
    // token on the install is deliberate here: this is a background job with no
    // caller, and without the fallback automatic enrichment would stop working
    // for every book not uploaded by whoever connected Hardcover.
    const ownerToken = await getHardcoverTokenForUser(book.createdBy);
    const candidates = await searchHardcover(query, ownerToken ? { token: ownerToken } : {});
    if (candidates.length === 0) {
      logger.info("hardcover returned no results");
      await job.log("Hardcover returned no results");
    } else {
      candidatesToInsert.push({ source: "hardcover", best: candidates[0] });
      await job.log(`Hardcover returned ${candidates.length} candidate(s)`);
    }
  } catch (err) {
    logger.withMetadata({ error: String(err) }).warn("hardcover search failed");
    await job.log(`Hardcover search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. No external candidates were found. The book still has the file-derived
  //    metadata candidate inserted during parsing (fetch-metadata is only ever
  //    enqueued for books that produced one), so it is already review-ready.
  //    Promote it from "inbox" to "review" instead of stranding it: otherwise
  //    a book whose automatic Hardcover query misses can never be approved,
  //    even after a successful manual search fills its fields.
  if (candidatesToInsert.length === 0) {
    if (!skipStatusChange && book.status === "inbox") {
      await db
        .update(books)
        .set({ status: "review", updatedAt: new Date() })
        .where(eq(books.id, bookId));
      logger.info(`Book ${bookId} → review (no external candidates; file metadata only)`);
      await job.log("No external candidates found; status → review (file metadata only)");
    } else {
      logger.warn(
        `Book ${bookId}: all metadata sources failed or returned no results — keeping current status "${book.status}"`,
      );
    }
    return;
  }

  // 6. Check for potential duplicates before transitioning to review
  // Skip duplicate detection when refetching for an already-organized book
  let possibleDuplicateOf: string | null = null;
  if (!skipStatusChange) {
    const bestCandidate = candidatesToInsert[0]?.best;
    const dupCheckIsbn = book.isbn13 || bestCandidate?.normalized?.isbn13 || null;
    const dupCheckTitle = book.title || bestCandidate?.normalized?.title || null;
    const dupCheckAuthor = book.author || bestCandidate?.normalized?.author || null;

    possibleDuplicateOf = await findPossibleDuplicate(
      db,
      bookId,
      dupCheckIsbn,
      dupCheckTitle,
      dupCheckAuthor,
    );
  }

  // 7. Insert candidates + update status atomically
  await db.transaction(async (tx) => {
    for (const { source, best } of candidatesToInsert) {
      await tx
        .insert(bookMetadataCandidates)
        .values({
          bookId,
          source: best.source,
          rawResponse: best.rawResponse,
          normalized: best.normalized,
          confidence: String(best.confidence),
        })
        .onConflictDoUpdate({
          target: [bookMetadataCandidates.bookId, bookMetadataCandidates.source],
          set: {
            rawResponse: best.rawResponse,
            normalized: best.normalized,
            confidence: String(best.confidence),
          },
        });
      logger.info(`Inserted ${source} candidate (confidence: ${best.confidence})`);
    }

    if (skipStatusChange) {
      await tx.update(books).set({ updatedAt: new Date() }).where(eq(books.id, bookId));
    } else {
      await tx
        .update(books)
        .set({
          status: "review",
          possibleDuplicateOf,
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));
    }
  });

  // A book that is already in the catalogue got here through the "refresh
  // metadata" path (skipStatusChange), and the transaction above bumped its
  // updatedAt — which is the OPDS entry's <updated> element (libris-021).
  //
  // Deliberately conditional: every other run of this worker happens to a book
  // in inbox or review, which no cached surface renders, so invalidating
  // unconditionally would spend a SCAN per book on a bulk import and clear
  // entries that could not have changed.
  if (book.status === "organized") {
    await invalidateRouteCache(getCacheStorage(), "/opds");
  }

  if (possibleDuplicateOf) {
    logger.info(`Book ${bookId} → review (possible duplicate of ${possibleDuplicateOf})`);
    await job.log(`Possible duplicate of book ${possibleDuplicateOf}`);
  }
  logger.info(`Book ${bookId} → review (${candidatesToInsert.length} candidate(s) inserted)`);
  await job.log(
    `Metadata fetch complete: ${candidatesToInsert.length} candidate(s), status → review`,
  );
}
