import { promises as fs } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { bookFiles, books, uploadRegistry } from "#db";
import { BookDetectedPayloadSchema } from "../types/index.js";
import type { BookDetectedPayload, BookFormat } from "../types/index.js";
import type { Job, Queue } from "bullmq";
import { getDb } from "../services/db.js";
import { computeChecksumFromFile } from "../shared/checksum.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("worker:book-detected");

const SUPPORTED_FORMATS = new Set<BookFormat>(["epub"]);

/**
 * Detect book format from file extension.
 */
function detectFormat(filePath: string): BookFormat | null {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return SUPPORTED_FORMATS.has(ext as BookFormat) ? (ext as BookFormat) : null;
}

/**
 * Creates a processor for newly detected book files from the inbox.
 * Uses a shared Queue instance (passed via closure) instead of creating per-job queues.
 *
 * Responsibilities:
 * - Compute SHA-256 checksum
 * - Detect format from file extension
 * - Create books record (status: 'inbox') and book_files record
 * - Enqueue BOOK_PARSE_FILE job
 */
export function createBookDetectedProcessor(parseQueue: Queue) {
  return async function processBookDetected(job: Job<BookDetectedPayload>): Promise<void> {
    const { filePath } = BookDetectedPayloadSchema.parse(job.data);
    logger.info(`Processing detected book: ${filePath}`);
    await job.log(`Processing detected book: ${filePath}`);

    const db = getDb();

    // 1. Verify file exists and get size
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    await job.log(`File verified: ${stat.size} bytes`);

    // 2. Detect format from extension
    const format = detectFormat(filePath);
    if (!format) {
      const ext = path.extname(filePath);
      logger.warn(`Unsupported file format "${ext}" for ${filePath}, skipping`);
      await job.log(`Unsupported format "${ext}", skipping`);
      return;
    }
    await job.log(`Detected format: ${format}`);

    // 3. Compute SHA-256 checksum
    const checksum = await computeChecksumFromFile(filePath);
    logger.info(`Checksum: ${checksum}`);
    await job.log(`Computed checksum: ${checksum}`);

    // 4. Check for duplicate by checksum (idempotent)
    const existing = await db.query.bookFiles.findFirst({
      where: { checksum },
    });

    if (existing) {
      logger.info(
        `Duplicate file detected (checksum ${checksum}), book ${existing.bookId} already exists — skipping`,
      );
      await job.log(`Duplicate detected (book ${existing.bookId}), skipping`);
      return;
    }

    // 5. Look up upload_registry to attribute ownership
    const registry = await db
      .select()
      .from(uploadRegistry)
      .where(eq(uploadRegistry.checksum, checksum))
      .orderBy(asc(uploadRegistry.createdAt))
      .limit(1)
      .then((rows) => rows[0]);

    if (registry) {
      logger.info(
        `Found upload registry entry for checksum ${checksum}, owner: ${registry.apiKeyId}`,
      );
      await job.log(`Upload registry match — owner apiKeyId: ${registry.apiKeyId}`);
    }

    // 6. Create books and book_files records atomically
    const originalName = registry?.filename ?? path.basename(filePath);

    const { book, bookFile } = await db.transaction(async (tx) => {
      const [newBook] = await tx
        .insert(books)
        .values({
          status: "inbox",
          ...(registry ? { createdBy: registry.apiKeyId } : {}),
        })
        .returning({ id: books.id });

      logger.info(`Created book record: ${newBook.id}`);

      const [newBookFile] = await tx
        .insert(bookFiles)
        .values({
          bookId: newBook.id,
          format,
          originalName,
          inboxPath: filePath,
          fileSize: stat.size,
          checksum,
        })
        .returning({ id: bookFiles.id });

      logger.info(`Created book_files record: ${newBookFile.id}`);

      return { book: newBook, bookFile: newBookFile };
    });
    await job.log(`Created book ${book.id} and book_file ${bookFile.id}`);

    // Clean up ALL registry rows for this checksum (not just the winner)
    // to prevent orphan accumulation when multiple users upload the same file
    await db.delete(uploadRegistry).where(eq(uploadRegistry.checksum, checksum));

    // 7. Enqueue BOOK_PARSE_FILE job AFTER transaction commits successfully
    await parseQueue.add("parse-file", {
      bookId: book.id,
      bookFileId: bookFile.id,
      filePath,
      format,
    });
    logger.info(`Enqueued BOOK_PARSE_FILE for book ${book.id}`);
    await job.log(`Enqueued parse-file job for book ${book.id}`);

    logger.info(`Book ${book.id} detection complete`);
    await job.log(`Detection complete for book ${book.id}`);
  };
}
