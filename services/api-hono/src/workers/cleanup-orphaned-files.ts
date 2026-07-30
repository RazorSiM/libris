import { realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "bullmq";
import { and, gt, inArray, isNotNull } from "drizzle-orm";
import { bookFiles } from "#db";
import { getDb } from "../services/db.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("worker:cleanup-orphaned-files");

/** Default page size for keyset-paginated scan of book_files. */
export const DEFAULT_BATCH_SIZE = 500;

export interface CleanupOrphanedFilesResult {
  result: string;
}

export interface CleanupOrphanedFilesOptions {
  /** Override the page size. Tests pass a small value to exercise multi-batch behavior cheaply. */
  batchSize?: number;
}

/**
 * Build a processor that scans `book_files` for rows whose `storage_path` no
 * longer exists on disk and deletes them.
 *
 * Uses keyset pagination over `bookFiles.id` so that deleting rows inside the
 * loop cannot cause the next iteration to skip work — `WHERE id > lastId`
 * always advances past previously-inspected rows regardless of which were
 * deleted.
 */
export function createCleanupOrphanedFilesProcessor(
  libraryPath: string,
  options: CleanupOrphanedFilesOptions = {},
) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  return async function processCleanupOrphanedFiles(job: Job): Promise<CleanupOrphanedFilesResult> {
    const db = getDb();
    const libraryRoot = await realpath(libraryPath);

    let lastId: string | null = null;
    let totalChecked = 0;
    let totalOrphaned = 0;

    while (true) {
      const conditions = [isNotNull(bookFiles.storagePath)];
      if (lastId !== null) conditions.push(gt(bookFiles.id, lastId));

      const rows = await db
        .select({ id: bookFiles.id, storagePath: bookFiles.storagePath })
        .from(bookFiles)
        .where(and(...conditions))
        .orderBy(bookFiles.id)
        .limit(batchSize);

      if (rows.length === 0) break;

      const orphanIds: string[] = [];
      for (const row of rows) {
        if (!row.storagePath) continue;
        const fullPath = join(libraryRoot, row.storagePath);
        try {
          await lstat(fullPath);
        } catch {
          orphanIds.push(row.id);
        }
      }

      if (orphanIds.length > 0) {
        await db.delete(bookFiles).where(inArray(bookFiles.id, orphanIds));
      }

      totalChecked += rows.length;
      totalOrphaned += orphanIds.length;
      lastId = rows[rows.length - 1].id;

      if (rows.length < batchSize) break;
    }

    const message = `Checked ${totalChecked} files, removed ${totalOrphaned} orphaned`;
    await job.log(message);
    logger.info(message);
    return { result: message };
  };
}
