import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { bookFiles, books, uploadRegistry, users } from "#db";
import { BookDetectedPayloadSchema } from "../types/index.js";
import type { BookDetectedPayload, BookFormat } from "../types/index.js";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { getDb } from "../services/db.js";
import { computeChecksumFromFile } from "../shared/checksum.js";
import { getLogger } from "../lib/logger.js";
import { getEnv } from "../env.js";
import {
  assertExistingPathWithinRoot,
  PathNotFoundError,
  PathOutsideRootError,
} from "../lib/assert-path-within-root.js";

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
 * The oldest admin, who owns anything that arrives without an uploader.
 *
 * Oldest rather than any admin so the choice is deterministic: two files
 * dropped in the same directory end up with the same owner, and re-running
 * ingestion does not shuffle ownership around.
 */
async function oldestAdminId(db: ReturnType<typeof getDb>): Promise<string> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!admin) {
    throw new Error(
      "Cannot ingest an unattributed file: no admin exists to own it. Complete first-run setup first.",
    );
  }
  return admin.id;
}

/**
 * Retire an inbox file whose contents are already in the library.
 *
 * Ingestion deduplicates by checksum, so this file will never produce a book.
 * Left alone, its `upload_registry` row survives forever and the file itself
 * accumulates in the inbox directory — `cleanup-orphaned-files` only deletes DB
 * rows whose file is missing, never the reverse.
 *
 * Only files that arrived through the upload API are removed, i.e. ones with a
 * registry row naming this exact file. A file dropped into the inbox by hand is
 * left where it is: it is not ours to delete, and its owner may be mid-copy.
 * The file backing the existing book is never touched, which is what makes
 * re-running detection over an already-ingested path safe.
 */
async function discardRedundantUpload(
  db: ReturnType<typeof getDb>,
  filePath: string,
  checksum: string,
  existingInboxPath: string | null,
  job: Job<BookDetectedPayload>,
): Promise<void> {
  const detectedName = path.basename(filePath);

  const [row] = await db
    .select({ id: uploadRegistry.id })
    .from(uploadRegistry)
    .where(and(eq(uploadRegistry.checksum, checksum), eq(uploadRegistry.filename, detectedName)))
    .limit(1);

  if (!row) return;

  await db.delete(uploadRegistry).where(eq(uploadRegistry.id, row.id));
  await job.log(`Released the upload registry entry for redundant file ${detectedName}`);

  if (existingInboxPath && path.resolve(existingInboxPath) === path.resolve(filePath)) {
    // This IS the file the existing book was ingested from — re-detection of an
    // already-known path, not a redundant copy.
    return;
  }

  try {
    await fs.unlink(filePath);
    logger.info(`Removed redundant inbox copy ${filePath} (checksum ${checksum})`);
    await job.log(`Removed redundant inbox copy ${detectedName}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Could not remove redundant inbox copy ${filePath}: ${String(error)}`);
    }
  }
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
export function createBookDetectedProcessor(
  parseQueue: Queue,
  inboxPath = getEnv().LIBRIS_INBOX_PATH,
) {
  return async function processBookDetected(job: Job<BookDetectedPayload>): Promise<void> {
    const { filePath } = BookDetectedPayloadSchema.parse(job.data);
    logger.info(`Processing detected book: ${filePath}`);
    await job.log(`Processing detected book: ${filePath}`);

    try {
      assertExistingPathWithinRoot(filePath, inboxPath);
    } catch (error: unknown) {
      if (error instanceof PathOutsideRootError) {
        throw new UnrecoverableError(`Refusing to ingest a path outside the inbox: ${filePath}`);
      }
      if (error instanceof PathNotFoundError) {
        throw new UnrecoverableError(`Inbox file not found: ${filePath}`);
      }
      throw error;
    }

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
      await discardRedundantUpload(db, filePath, checksum, existing.inboxPath, job);
      return;
    }

    // 5. Look up upload_registry to attribute ownership.
    //
    // Prefer the row describing the file actually being ingested over the
    // oldest one: when two users upload identical bytes seconds apart the
    // second file is collision-renamed, and going by registry age would credit
    // the book to the user whose file was NOT the one ingested.
    const registryRows = await db
      .select()
      .from(uploadRegistry)
      .where(eq(uploadRegistry.checksum, checksum))
      .orderBy(asc(uploadRegistry.createdAt));

    const detectedName = path.basename(filePath);
    const registry = registryRows.find((row) => row.filename === detectedName) ?? registryRows[0];

    if (registry) {
      logger.info(
        `Found upload registry entry for checksum ${checksum}, owner: ${registry.userId}`,
      );
      await job.log(`Upload registry match — owner userId: ${registry.userId}`);
    }

    // 5b. Files the watcher picks up straight from the inbox directory were
    // never uploaded through the API, so nothing recorded who they belong to.
    // books.created_by is NOT NULL since the cutover, so they go to the oldest
    // admin — the same rule the cutover migration applied to the books it found
    // unowned. Failing here leaves the file in the inbox to be retried, which
    // beats inventing an owner.
    const ownerId = registry?.userId ?? (await oldestAdminId(db));
    if (!registry) {
      logger.info(
        `No upload registry entry for checksum ${checksum}, assigning to admin ${ownerId}`,
      );
      await job.log(`Unattributed file — assigned to admin ${ownerId}`);
    }

    // 6. Create books and book_files records atomically
    const originalName = registry?.filename ?? path.basename(filePath);

    const { book, bookFile } = await db.transaction(async (tx) => {
      const [newBook] = await tx
        .insert(books)
        .values({
          status: "inbox",
          createdBy: ownerId,
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

    // Consume only the row this file came from. Wiping every row for the
    // checksum used to destroy the other uploader's attribution as well, and
    // their file then had nothing left to match against when the watcher got
    // to it. Any sibling row is cleaned up by discardRedundantUpload when its
    // own file is detected and recognised as a duplicate.
    if (registry) {
      await db.delete(uploadRegistry).where(eq(uploadRegistry.id, registry.id));
    }

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
