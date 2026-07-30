import { createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bookFiles, books } from "#db";
import { computePartialMd5 } from "../lib/content-hash.js";
import { linkOrphanProgressForBook } from "../lib/progress-linking.js";
import { embedEpubMetadata } from "../lib/epub/embed-metadata.js";
import { extractEpubCoverImage } from "../lib/metadata/index.js";
import { BookOrganizePayloadSchema } from "../types/index.js";
import type { BookOrganizePayload } from "../types/index.js";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { getDb } from "../services/db.js";
import { getEnv } from "../env.js";
import { assertNotInternalUrl } from "../shared/ssrf.js";
import { getLogger } from "../lib/logger.js";

const MAX_COVER_SIZE = 10 * 1024 * 1024; // 10 MB
const COVER_FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const ALLOWED_COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const logger = getLogger("worker:book-organize");

/**
 * Sanitize a string for use as a filesystem directory/file name.
 * Replaces characters unsafe on common filesystems and trims to 200 chars.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[/:?*"<>|\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Move a file, falling back to copy+delete when source and destination
 * are on different filesystems (EXDEV).
 */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(src, dest);
      await unlink(src);
    } else {
      throw err;
    }
  }
}

/**
 * Organizes an approved book into the library.
 *
 * Responsibilities:
 * - Move file to /library/<Author>/<Title>/<filename.ext>
 * - Download cover image to /library/<Author>/<Title>/cover.jpg
 * - Update books record with final metadata + status: 'organized'
 * - Idempotent: checks if destination already exists before moving
 */
export async function processBookOrganize(job: Job<BookOrganizePayload>): Promise<void> {
  const { bookId, forceRedownloadCover } = BookOrganizePayloadSchema.parse(job.data);
  logger.info(`Organizing book ${bookId}`);
  await job.log(`Organizing book ${bookId}`);

  const db = getDb();
  const libraryPath = await realpath(getEnv().LIBRIS_LIBRARY_PATH);

  // 1. Fetch book record
  const book = await db.query.books.findFirst({
    where: { id: bookId },
  });

  if (!book) {
    throw new Error(`Book ${bookId} not found`);
  }

  const isReorganize = book.status === "organized";

  const author = book.author || "Unknown Author";
  const title = book.title || "Unknown Title";

  const safeAuthor = sanitizeName(author);
  const safeTitle = sanitizeName(title);
  const destDir = join(libraryPath, safeAuthor, safeTitle);

  // 2. Create destination directory
  await mkdir(destDir, { recursive: true });
  await job.log(`Destination: ${destDir}`);

  // 3. Fetch book files and move each one
  const files = await db.query.bookFiles.findMany({
    where: { bookId },
  });

  if (files.length === 0) {
    throw new Error(`No files found for book ${bookId}`);
  }
  await job.log(`Moving ${files.length} file(s)`);

  // Track old directories to clean up after re-organize
  const oldDirsToClean = new Set<string>();

  for (const file of files) {
    // For re-organize: use current library location as source when inboxPath is null
    let sourcePath: string;
    if (file.inboxPath) {
      sourcePath = file.inboxPath;
    } else if (file.storagePath) {
      sourcePath = join(libraryPath, file.storagePath);
    } else {
      logger.warn(`File ${file.id} has no inbox or storage path, skipping`);
      continue;
    }

    const fileName = basename(sourcePath);
    const destPath = join(destDir, fileName);
    const storagePath = join(safeAuthor, safeTitle, fileName);

    // Validate destPath resolves within the library to prevent path traversal
    const resolvedDest = resolve(destPath);
    if (!resolvedDest.startsWith(libraryPath + sep)) {
      throw new Error(`Destination path escapes library: ${resolvedDest}`);
    }

    // Skip move if source and destination resolve to the same path
    const resolvedSource = resolve(sourcePath);
    if (resolvedSource === resolvedDest) {
      logger.info(`File already at correct location: ${destPath}, updating DB only`);
      const contentHash = await computePartialMd5(resolvedDest);
      await db
        .update(bookFiles)
        .set({ storagePath, contentHash, inboxPath: null })
        .where(eq(bookFiles.id, file.id));
      continue;
    }

    // Track old directory for cleanup during re-organize
    if (isReorganize && file.storagePath) {
      const oldDir = resolve(join(libraryPath, file.storagePath, ".."));
      if (oldDir !== resolve(destDir)) {
        oldDirsToClean.add(oldDir);
      }
    }

    // Use lstat to check source (doesn't follow symlinks)
    const sourceStat = await lstat(sourcePath).catch(() => null);
    if (!sourceStat) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Source is a symlink, refusing to move: ${sourcePath}`);
    }

    // Check destination directory hasn't been replaced with a symlink (TOCTOU defense)
    const destDirStat = await lstat(destDir).catch(() => null);
    if (destDirStat?.isSymbolicLink()) {
      throw new Error(`Destination directory is a symlink, refusing: ${destDir}`);
    }

    // Atomic move: attempt rename directly, handle EEXIST for idempotency
    try {
      await moveFile(sourcePath, destPath);
      logger.info(`Moved ${sourcePath} → ${destPath}`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        logger.info(`Destination already exists: ${destPath}, skipping move`);
      } else if (code === "ENOENT") {
        // Source gone — check if dest already exists (previous incomplete run)
        const destStat = await lstat(destPath).catch(() => null);
        if (destStat) {
          logger.info(`Source gone but destination exists: ${destPath}, treating as already moved`);
        } else {
          throw new Error(`Source file not found: ${sourcePath}`);
        }
      } else {
        throw err;
      }
    }

    // Compute MD5 content hash (used by KoReader to identify documents)
    const finalPath = join(destDir, basename(sourcePath));
    const contentHash = await computePartialMd5(finalPath);

    // Update book_files record with storage path, content hash, clear inbox path
    await db
      .update(bookFiles)
      .set({ storagePath, contentHash, inboxPath: null })
      .where(eq(bookFiles.id, file.id));

    // Link any progress a device pushed before this book was organized (the
    // document hash didn't resolve to a book yet, so book_id was left NULL).
    const linked = await linkOrphanProgressForBook(db, bookId, [contentHash]);
    if (linked > 0) {
      logger.info(`Linked ${linked} orphaned progress rows to book ${bookId}`);
    }
  }

  // 4. Download cover image if cover URL is available
  let coverPath: string | null = null;

  if (book.coverUrl) {
    const coverDest = join(destDir, "cover.jpg");
    const coverStoragePath = join(safeAuthor, safeTitle, "cover.jpg");

    // Remove existing cover when forced re-download is requested (e.g. coverUrl changed)
    if (forceRedownloadCover) {
      await unlink(coverDest).catch(() => {});
      logger.info("Force re-download: removed existing cover");
    }

    // Check if cover already downloaded (use lstat to avoid following symlinks)
    const coverStat = await lstat(coverDest).catch(() => null);
    if (coverStat) {
      logger.info("Cover already exists, skipping download");
      coverPath = coverStoragePath;
    } else {
      try {
        // SSRF protection: validate URL does not target internal/private IPs
        await assertNotInternalUrl(book.coverUrl);

        const response = await fetch(book.coverUrl, {
          signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
        });

        if (!response.ok) {
          logger.warn(`Failed to download cover: HTTP ${response.status}`);
        } else if (!response.body) {
          logger.warn("Cover response has no body");
        } else {
          // Validate Content-Type
          const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
          if (contentType && !ALLOWED_COVER_TYPES.has(contentType)) {
            logger.warn(`Cover has disallowed Content-Type: ${contentType}, skipping`);
          } else {
            // Validate Content-Length if present
            const contentLength = response.headers.get("content-length");
            if (contentLength && Number(contentLength) > MAX_COVER_SIZE) {
              logger.warn(`Cover too large (${contentLength} bytes), skipping`);
            } else {
              // Stream with size limit
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node/Web ReadableStream type mismatch
              const nodeStream = Readable.fromWeb(response.body as any);
              const tmpDest = coverDest + ".tmp";
              const ws = createWriteStream(tmpDest);
              let downloaded = 0;

              nodeStream.on("data", (chunk: Buffer) => {
                downloaded += chunk.length;
                if (downloaded > MAX_COVER_SIZE) {
                  nodeStream.destroy(new Error(`Cover download exceeded ${MAX_COVER_SIZE} bytes`));
                }
              });

              await pipeline(nodeStream, ws);

              // Atomic move from tmp to final destination
              await moveFile(tmpDest, coverDest);
              coverPath = coverStoragePath;
              logger.info(`Downloaded cover to ${coverDest}`);
            }
          }
        }
      } catch (err) {
        // Clean up partial tmp file on failure
        const tmpDest = coverDest + ".tmp";
        await unlink(tmpDest).catch(() => {});
        logger
          .withMetadata({ error: String(err) })
          .warn("Cover download failed, continuing without cover");
      }
    }
  }

  // 4b. For re-organize, move existing cover from old location if present
  if (!coverPath && isReorganize && book.coverPath) {
    const oldCoverPath = join(libraryPath, book.coverPath);
    const coverDest = join(destDir, "cover.jpg");
    const coverStoragePath = join(safeAuthor, safeTitle, "cover.jpg");

    const resolvedOldCover = resolve(oldCoverPath);
    const resolvedNewCover = resolve(coverDest);

    if (resolvedOldCover === resolvedNewCover) {
      // Cover already in correct location
      coverPath = coverStoragePath;
    } else {
      const oldCoverStat = await lstat(oldCoverPath).catch(() => null);
      if (oldCoverStat && !oldCoverStat.isSymbolicLink()) {
        try {
          await moveFile(oldCoverPath, coverDest);
          coverPath = coverStoragePath;
          logger.info(`Moved cover ${oldCoverPath} → ${coverDest}`);
        } catch {
          logger.warn("Failed to move existing cover, will attempt re-download/extract");
        }
      }
    }
  }

  // 4c. Fallback: extract cover from EPUB if no cover was obtained
  if (!coverPath) {
    const epubFile = files.find((f) => {
      const name = f.storagePath || f.inboxPath;
      return name?.toLowerCase().endsWith(".epub");
    });

    if (epubFile) {
      try {
        const epubFileName = basename(epubFile.storagePath || epubFile.inboxPath!);
        const epubPath = join(destDir, epubFileName);
        const coverData = await extractEpubCoverImage(epubPath);
        if (coverData && coverData.length > 0) {
          const coverDest = join(destDir, "cover.jpg");
          const coverStoragePath = join(safeAuthor, safeTitle, "cover.jpg");
          await writeFile(coverDest, coverData);
          coverPath = coverStoragePath;
          logger.info("Extracted cover from EPUB");
        }
      } catch (err) {
        logger
          .withMetadata({ error: String(err) })
          .warn("Failed to extract cover from EPUB, continuing without cover");
      }
    }
  }

  // 5. Embed approved metadata into epub files
  for (const file of files) {
    const storageName = file.storagePath || file.inboxPath;
    if (!storageName?.toLowerCase().endsWith(".epub")) continue;
    const epubPath = join(destDir, basename(storageName));
    try {
      await embedEpubMetadata(
        epubPath,
        {
          title: book.title,
          author: book.author,
          isbn10: book.isbn10,
          isbn13: book.isbn13,
          publisher: book.publisher,
          publishedYear: book.publishedYear,
          language: book.language,
          description: book.description,
          genres: book.genres,
        },
        coverPath ? join(libraryPath, coverPath) : undefined,
      );
      // Recompute MD5 since file content changed; keep the pre-embedding
      // hash so KoSync progress from the original file still matches.
      const contentHash = await computePartialMd5(epubPath);
      await db
        .update(bookFiles)
        .set({ contentHash, originalContentHash: file.contentHash })
        .where(eq(bookFiles.id, file.id));
      // Re-link orphaned progress against both the new and pre-embed hashes.
      await linkOrphanProgressForBook(db, bookId, [contentHash, file.contentHash]);
      logger.info(`Embedded metadata into ${epubPath}`);
    } catch (err) {
      logger
        .withMetadata({ error: String(err) })
        .warn("Failed to embed metadata into epub, continuing");
    }
  }

  // 6. Update book record: status → organized
  await db
    .update(books)
    .set({
      status: "organized",
      coverPath,
      updatedAt: new Date(),
    })
    .where(eq(books.id, bookId));

  // 7. Clean up empty old directories after re-organize
  for (const oldDir of oldDirsToClean) {
    try {
      // rmdir only succeeds on empty directories — safe to call unconditionally
      await rmdir(oldDir);
      // Also try removing parent (e.g. old author dir) if empty
      const parentDir = resolve(oldDir, "..");
      if (parentDir !== libraryPath) {
        await rmdir(parentDir);
      }
      logger.info(`Cleaned up old directory: ${oldDir}`);
    } catch {
      // Directory not empty or already removed — that's fine
    }
  }

  logger.info(`Book ${bookId} organized successfully → ${destDir}`);
  await job.log(`Book ${bookId} organized successfully`);
}
