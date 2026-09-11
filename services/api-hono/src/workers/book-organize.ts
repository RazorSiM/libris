import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { bookFiles, books } from "#db";
import { computePartialMd5 } from "../lib/content-hash.js";
import { computeChecksumFromFile } from "../shared/checksum.js";
import { linkOrphanProgressForBook } from "../lib/progress-linking.js";
import { embedEpubMetadata } from "../lib/epub/embed-metadata.js";
import { extractEpubCoverImage } from "../lib/metadata/index.js";
import { BookOrganizePayloadSchema } from "../types/index.js";
import type { BookOrganizePayload } from "../types/index.js";
import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { getDb } from "../services/db.js";
import { getCacheStorage } from "../services/cache-storage.js";
import { invalidateRouteCache } from "../services/cache.js";
import { getEnv } from "../env.js";
import { fetchExternalImage } from "../shared/secure-image-fetch.js";
import { getLogger } from "../lib/logger.js";

const COVER_FETCH_TIMEOUT_MS = 30_000; // 30 seconds

const logger = getLogger("worker:book-organize");

/**
 * Sanitize a string for use as a filesystem directory/file name.
 * Replaces characters unsafe on common filesystems and trims to 200 chars.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .replace(/[/:?*"<>|\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 200);

  if (
    sanitized === "" ||
    sanitized === "." ||
    sanitized === ".." ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)
  ) {
    return `_${sanitized.replace(/\./g, "dot") || "unnamed"}`;
  }
  return sanitized;
}

/**
 * Short, stable discriminator that keeps two books with the same author and
 * title out of each other's directory.
 *
 * Without it, both books resolve to `<Author>/<Title>` and the second organize
 * replaces the first book's file and cover — the P1 collision this worker used
 * to cause. The book id is a UUID; the first 8 hex characters are enough to
 * separate books in any real library while keeping the path readable.
 */
export function bookDirectorySuffix(bookId: string): string {
  const compact = bookId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return compact.slice(0, 8) || "book";
}

/** Validate the complete destination before creating anything on disk. */
export async function createDestinationDirectory(
  libraryPath: string,
  destination: string,
): Promise<void> {
  const resolvedDestination = resolve(destination);
  if (!resolvedDestination.startsWith(libraryPath + sep)) {
    throw new Error(`Destination path escapes library: ${resolvedDestination}`);
  }
  await mkdir(resolvedDestination, { recursive: true });
}

/**
 * Move a file onto `dest`, replacing anything already there.
 *
 * Only for destinations this book already owns (promoting a `cover.jpg.tmp`
 * over the cover it replaces). Book payload files use `moveFileNoClobber` so an
 * existing file is never silently overwritten.
 */
async function replaceFile(src: string, dest: string): Promise<void> {
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

/** Errno codes that mean hard links are unavailable and a copy must be tried. */
const NO_HARDLINK_CODES = new Set(["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EMLINK"]);

/**
 * Move a file to `dest` without ever replacing an existing file.
 *
 * `rename` is deliberately not used: POSIX rename silently replaces the
 * destination, which is the data-loss bug this worker used to have. `link` is
 * atomic and fails with EEXIST when `dest` exists; where hard links are not
 * available (cross-device moves, filesystems without them) `copyFile` with
 * COPYFILE_EXCL gives the same no-clobber guarantee.
 */
async function moveFileNoClobber(src: string, dest: string): Promise<void> {
  try {
    await link(src, dest);
    await unlink(src);
    return;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
  }
  await copyFile(src, dest, fsConstants.COPYFILE_EXCL);
  await unlink(src);
}

function splitFileName(fileName: string): { stem: string; ext: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { stem: fileName, ext: "" };
  return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

function candidateFileName(fileName: string, attempt: number): string {
  if (attempt === 0) return fileName;
  const { stem, ext } = splitFileName(fileName);
  return `${stem}-${attempt}${ext}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Move `src` into `dir` under a name that cannot replace another file.
 *
 * Returns the absolute destination path, including any collision suffix. The
 * suffix keeps two files of one book (or a same-named file left behind by an
 * earlier failed attempt) from replacing each other.
 */
async function moveIntoDirectory(src: string, dir: string, fileName: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const dest = join(dir, candidateFileName(fileName, attempt));
    try {
      await moveFileNoClobber(src, dest);
      return dest;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") continue;
      throw err;
    }
  }
}

interface MovableFile {
  checksum: string | null;
  contentHash: string | null;
  originalContentHash: string | null;
}

/**
 * Whether `filePath` is the file the database already knows about.
 *
 * The full SHA-256 checksum covers the uploaded bytes; the partial-MD5 content
 * hash covers files that were moved before the checksum column existed. With
 * neither recorded there is nothing to verify against, so the answer is "no" —
 * an unverifiable file must never be adopted.
 */
async function verifyFileChecksum(filePath: string, file: MovableFile): Promise<boolean> {
  if (file.checksum) {
    return (await computeChecksumFromFile(filePath)) === file.checksum;
  }
  if (file.contentHash) {
    return (await computePartialMd5(filePath)) === file.contentHash;
  }
  if (file.originalContentHash) {
    return (await computePartialMd5(filePath)) === file.originalContentHash;
  }
  return false;
}

/**
 * Find a destination this book's file may already have been moved to.
 *
 * This is the recovery half of R04: a worker that moved the file and then died
 * before the database update retries with a missing source. Only an exact
 * checksum match is adopted, so a same-named file belonging to another book can
 * never be linked into this one's catalogue.
 */
async function findVerifiedDestination(
  destDir: string,
  fileName: string,
  file: MovableFile,
): Promise<string | null> {
  const { stem, ext } = splitFileName(fileName);
  const suffixPattern = new RegExp(`^${escapeRegExp(stem)}(?:-\\d+)?${escapeRegExp(ext)}$`);

  const entries = await readdir(destDir).catch(() => null);
  if (!entries) return null;

  const candidates = entries
    .filter((name) => name === fileName || suffixPattern.test(name))
    .sort((a, b) => (a === fileName ? -1 : b === fileName ? 1 : a.localeCompare(b)));

  for (const name of candidates) {
    const candidate = join(destDir, name);
    try {
      const stat = await lstat(candidate);
      if (stat.isFile() && (await verifyFileChecksum(candidate, file))) {
        return candidate;
      }
    } catch {
      // Unreadable candidate — keep looking; never adopt what cannot be verified.
    }
  }
  return null;
}

/**
 * Organizes an approved book into the library.
 *
 * Responsibilities:
 * - Move file to /library/<Author>/<Title> (<book id>)/<filename.ext>
 * - Download cover image to the same directory as cover.jpg
 * - Update books record with final metadata + status: 'organized'
 * - Idempotent: verifies the destination by checksum before adopting it, and
 *   never replaces an existing destination file
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
  const destDirName = `${safeTitle} (${bookDirectorySuffix(bookId)})`;
  const destDir = join(libraryPath, safeAuthor, destDirName);

  // 2. Validate the complete destination before creating anything on disk.
  await createDestinationDirectory(libraryPath, destDir);
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
  // Where each file actually ended up, keyed by book_files.id. The on-disk name
  // may differ from the source name when the allocator had to add a suffix.
  const movedFiles = new Map<string, { finalPath: string; storagePath: string }>();

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
      const storagePath = relative(libraryPath, resolvedDest);
      await db
        .update(bookFiles)
        .set({ storagePath, contentHash, inboxPath: null })
        .where(eq(bookFiles.id, file.id));
      movedFiles.set(file.id, { finalPath: resolvedDest, storagePath });
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

    let finalPath: string;
    if (!sourceStat) {
      // The previous attempt may have moved the file and then failed before
      // the database update. Adopt the destination only if it is verifiably
      // this file; otherwise fail the way the missing source deserves.
      const recovered = await findVerifiedDestination(destDir, fileName, file);
      if (!recovered) {
        throw new Error(`Source file not found: ${sourcePath}`);
      }
      logger.info(`Source gone, resuming with verified destination: ${recovered}`);
      await job.log(`Recovered previously moved file: ${recovered}`);
      finalPath = recovered;
    } else {
      if (sourceStat.isSymbolicLink()) {
        throw new Error(`Source is a symlink, refusing to move: ${sourcePath}`);
      }

      // Check destination directory hasn't been replaced with a symlink (TOCTOU defense)
      const destDirStat = await lstat(destDir).catch(() => null);
      if (destDirStat?.isSymbolicLink()) {
        throw new Error(`Destination directory is a symlink, refusing: ${destDir}`);
      }

      // Atomic, no-clobber move; allocates a suffix on a name collision.
      try {
        finalPath = await moveIntoDirectory(sourcePath, destDir, fileName);
        logger.info(`Moved ${sourcePath} → ${finalPath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Source vanished between the lstat and the move (or a concurrent
          // worker got there first). Only a verified destination is accepted.
          const recovered = await findVerifiedDestination(destDir, fileName, file);
          if (!recovered) {
            throw new Error(`Source file not found: ${sourcePath}`);
          }
          logger.info(`Source vanished mid-move, resumed at: ${recovered}`);
          finalPath = recovered;
        } else {
          throw err;
        }
      }
    }

    // Compute MD5 content hash (used by KoReader to identify documents)
    const contentHash = await computePartialMd5(finalPath);
    const storagePath = relative(libraryPath, finalPath);

    // Update book_files record with storage path, content hash, clear inbox path
    await db
      .update(bookFiles)
      .set({ storagePath, contentHash, inboxPath: null })
      .where(eq(bookFiles.id, file.id));
    movedFiles.set(file.id, { finalPath, storagePath });

    // Link any progress a device pushed before this book was organized (the
    // document hash didn't resolve to a book yet, so book_id was left NULL).
    const linked = await linkOrphanProgressForBook(db, bookId, [contentHash]);
    if (linked > 0) {
      logger.info(`Linked ${linked} orphaned progress rows to book ${bookId}`);
    }
  }

  // 4. Download cover image if cover URL is available
  let coverPath: string | null = null;
  const coverDest = join(destDir, "cover.jpg");
  const coverStoragePath = join(safeAuthor, destDirName, "cover.jpg");

  if (book.coverUrl) {
    // A forced re-download leaves the existing cover in place until the new one
    // has been fetched and validated. Unlinking first turned a fetch failure
    // into a permanently missing cover with no fallback left to run.
    const coverStat = await lstat(coverDest).catch(() => null);
    if (!forceRedownloadCover && coverStat && !coverStat.isSymbolicLink()) {
      logger.info("Cover already exists, skipping download");
      coverPath = coverStoragePath;
    } else {
      try {
        const image = await fetchExternalImage(book.coverUrl, {
          timeoutMs: COVER_FETCH_TIMEOUT_MS,
          allowedOrigins: getEnv().LIBRIS_COVER_FETCH_ALLOWLIST,
        });
        const tmpDest = coverDest + ".tmp";
        await writeFile(tmpDest, image.data);
        // Replaces the old cover only now that the replacement is on disk.
        await replaceFile(tmpDest, coverDest);
        coverPath = coverStoragePath;
        logger.info(`Downloaded validated ${image.contentType} cover to ${coverDest}`);
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

    const resolvedOldCover = resolve(oldCoverPath);
    const resolvedNewCover = resolve(coverDest);

    if (resolvedOldCover === resolvedNewCover) {
      // Cover already in the correct location — but only claim it if it is
      // still there. A missing file must not be written back as coverPath.
      const existing = await lstat(resolvedNewCover).catch(() => null);
      if (existing && !existing.isSymbolicLink()) {
        coverPath = coverStoragePath;
      }
    } else {
      const oldCoverStat = await lstat(oldCoverPath).catch(() => null);
      if (oldCoverStat && !oldCoverStat.isSymbolicLink()) {
        try {
          await replaceFile(oldCoverPath, coverDest);
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
    const movedEpub = epubFile ? movedFiles.get(epubFile.id) : undefined;

    if (movedEpub) {
      try {
        const coverData = await extractEpubCoverImage(movedEpub.finalPath);
        if (coverData && coverData.length > 0) {
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
    const originalName = file.storagePath || file.inboxPath;
    if (!originalName?.toLowerCase().endsWith(".epub")) continue;
    const moved = movedFiles.get(file.id);
    if (!moved) continue;

    try {
      await embedEpubMetadata(
        moved.finalPath,
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
      const contentHash = await computePartialMd5(moved.finalPath);
      await db
        .update(bookFiles)
        .set({ contentHash, originalContentHash: file.contentHash })
        .where(eq(bookFiles.id, file.id));
      // Re-link orphaned progress against both the new and pre-embed hashes.
      await linkOrphanProgressForBook(db, bookId, [contentHash, file.contentHash]);
      logger.info(`Embedded metadata into ${moved.finalPath}`);
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

  // 6b. Everything the catalogue renders about this book has just changed
  // underneath whatever the cache is still serving.
  //
  // POST /{id}/approve set the status and invalidated on its way out, so the
  // feed an e-reader refreshed a second later already listed this book — with
  // `coverPath` still null, because that is written here, minutes later for a
  // large file. `bookToEntry` decides the entry's cover link on `coverPath`, so
  // without this the freshly approved book sat in the catalogue with no cover
  // for the rest of the entry's 60-120s TTL. Re-organizing an existing book has
  // the same shape: the storage paths behind its acquisition links move here.
  //
  // `/api/stats` too: an organized book joins the genre distribution, the top
  // authors and the library-growth series.
  await invalidateRouteCache(getCacheStorage(), "/opds", "/api/stats");

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
