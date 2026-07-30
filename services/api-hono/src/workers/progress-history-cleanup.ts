import { readingProgressHistory } from "#db";
import { lt } from "drizzle-orm";
import type { Job } from "bullmq";
import { getDb } from "../services/db.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("worker:progress-history-cleanup");

/** Retention: keep 1 year of history */
const RETENTION_DAYS = 365;

export async function processProgressHistoryCleanup(job: Job): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  await job.log(`Cleaning entries older than ${cutoff.toISOString()}`);
  await db.delete(readingProgressHistory).where(lt(readingProgressHistory.createdAt, cutoff));

  logger.info(`Cleaned up reading progress history entries older than ${cutoff.toISOString()}`);
  await job.log(`Cleanup complete`);
}
