import { bookMetadataCandidates, books } from "#db";
import { normalizeLanguage } from "../lib/languages.js";
import { predictLanguage } from "../lib/metadata/detect-language.js";
import { extractEpubMetadata, extractEpubTextSample } from "../lib/metadata/index.js";
import { BookParseFilePayloadSchema } from "../types/index.js";
import type { BookParseFilePayload, NormalizedMetadata } from "../types/index.js";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { getDb } from "../services/db.js";
import { getLogger } from "../lib/logger.js";
import { getEnv } from "../env.js";
import {
  assertExistingPathWithinRoot,
  PathNotFoundError,
  PathOutsideRootError,
} from "../lib/assert-path-within-root.js";

const logger = getLogger("worker:book-parse-file");

/**
 * Build a search query string for BOOK_FETCH_METADATA from extracted metadata.
 * Prefers ISBN, falls back to "Title by Author" or just title.
 */
function buildSearchQuery(meta: NormalizedMetadata): string | null {
  const parts: string[] = [];

  if (meta.isbn13) parts.push(`isbn:${meta.isbn13}`);
  else if (meta.isbn10) parts.push(`isbn:${meta.isbn10}`);

  if (meta.title) {
    const titlePart = meta.author ? `${meta.title} by ${meta.author}` : meta.title;
    parts.push(titlePart);
  }

  return parts.join(" ") || null;
}

/**
 * Creates a processor for extracting embedded metadata from book files.
 * Uses a shared Queue instance (passed via closure) instead of creating per-job queues.
 *
 * Responsibilities:
 * - Call the appropriate extractor (EPUB/PDF) based on format
 * - Insert book_metadata_candidates record (source: 'file')
 * - Partially populate books fields from extracted metadata
 * - Enqueue BOOK_FETCH_METADATA job
 */
export function createBookParseFileProcessor(
  fetchMetadataQueue: Queue,
  inboxPath = getEnv().LIBRIS_INBOX_PATH,
) {
  return async function processBookParseFile(job: Job<BookParseFilePayload>): Promise<void> {
    const { bookId, filePath, format } = BookParseFilePayloadSchema.parse(job.data);
    logger.info(`Parsing ${format} file for book ${bookId}: ${filePath}`);
    await job.log(`Parsing ${format} file for book ${bookId}`);

    try {
      assertExistingPathWithinRoot(filePath, inboxPath);
    } catch (error: unknown) {
      if (error instanceof PathOutsideRootError) {
        throw new UnrecoverableError(`Refusing to parse a path outside the inbox: ${filePath}`);
      }
      if (error instanceof PathNotFoundError) {
        throw new UnrecoverableError(`Inbox file not found: ${filePath}`);
      }
      throw error;
    }

    const db = getDb();

    // 1. Verify book exists
    const book = await db.query.books.findFirst({
      where: { id: bookId },
    });

    if (!book) {
      throw new Error(`Book ${bookId} not found`);
    }
    await job.log(`Book ${bookId} found, extracting metadata`);

    // 2. Extract metadata from EPUB
    const metadata: NormalizedMetadata = await extractEpubMetadata(filePath);

    const hasMetadata = Object.values(metadata).some(
      (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    );

    if (hasMetadata) {
      logger.info(`Extracted metadata: title="${metadata.title}", author="${metadata.author}"`);
      await job.log(`Extracted metadata: title="${metadata.title}", author="${metadata.author}"`);
    } else {
      logger.warn(`No metadata extracted from ${format} file`);
      await job.log(`No metadata extracted from ${format} file`);
    }

    // 3. Insert candidate and update book fields atomically
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    // Predict the canonical language: normalized embedded tag, else detected
    // from the book's body prose, else from the title + description. Only crack
    // open the body when there is no usable tag (the rare path) and the book
    // doesn't already have a language.
    let bodySample: string | undefined;
    if (!book.language && !normalizeLanguage(metadata.language ?? null) && format === "epub") {
      bodySample = await extractEpubTextSample(filePath);
    }
    const predictedLanguage = await predictLanguage(metadata, bodySample);

    if (metadata.title && !book.title) updates.title = metadata.title;
    if (metadata.author && !book.author) updates.author = metadata.author;
    if (metadata.isbn10 && !book.isbn10) updates.isbn10 = metadata.isbn10;
    if (metadata.isbn13 && !book.isbn13) updates.isbn13 = metadata.isbn13;
    if (metadata.publisher && !book.publisher) updates.publisher = metadata.publisher;
    if (metadata.publishedYear && !book.publishedYear)
      updates.publishedYear = metadata.publishedYear;
    if (predictedLanguage && !book.language) updates.language = predictedLanguage;
    if (metadata.description && !book.description) updates.description = metadata.description;
    if (metadata.coverUrl && !book.coverUrl) updates.coverUrl = metadata.coverUrl;
    if (metadata.pageCount && !book.pageCount) updates.pageCount = metadata.pageCount;
    if (metadata.genres && metadata.genres.length > 0 && book.genres.length === 0) {
      updates.genres = metadata.genres;
    }

    const searchQuery = hasMetadata ? buildSearchQuery(metadata) : null;

    await db.transaction(async (tx) => {
      if (hasMetadata) {
        await tx
          .insert(bookMetadataCandidates)
          .values({
            bookId,
            source: "file",
            rawResponse: null,
            normalized: metadata,
            confidence: "1.00",
          })
          .onConflictDoUpdate({
            target: [bookMetadataCandidates.bookId, bookMetadataCandidates.source],
            set: {
              rawResponse: null,
              normalized: metadata,
              confidence: "1.00",
            },
          });

        logger.info(`Inserted file metadata candidate for book ${bookId}`);
      }

      if (!hasMetadata && book.status !== "review") {
        updates.status = "review";
      }

      await tx.update(books).set(updates).where(eq(books.id, bookId));
    });

    if (!hasMetadata || !searchQuery) {
      logger.warn(
        `Book ${bookId}: no searchable metadata extracted from ${format}; moved to manual review`,
      );
      await job.log(`No searchable metadata extracted from ${format}; book moved to manual review`);
      logger.info(`Book ${bookId} file parsing complete`);
      await job.log(`File parsing complete for book ${bookId}`);
      return;
    }

    // 4. Enqueue BOOK_FETCH_METADATA job AFTER transaction commits successfully
    await fetchMetadataQueue.add("fetch-metadata", { bookId, searchQuery });
    logger.info(`Enqueued BOOK_FETCH_METADATA for book ${bookId}: "${searchQuery}"`);
    await job.log(`Enqueued fetch-metadata for book ${bookId}: "${searchQuery}"`);

    logger.info(`Book ${bookId} file parsing complete`);
    await job.log(`File parsing complete for book ${bookId}`);
  };
}
