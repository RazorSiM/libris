import { sql, and, eq } from "drizzle-orm";
import { readingAggregate, readingProgress } from "#db";
import type { Db } from "#db";
import { FINISHED_THRESHOLD } from "./reading-status.js";

/**
 * Recompute the per-(user, book) lifecycle aggregate from current
 * reading_progress rows for `(apiKeyId, document)` and upsert it.
 *
 * `startedAt` is the earliest timestamp where percentage > 0 across all
 * devices; `finishedAt` is the earliest timestamp where percentage crossed
 * `FINISHED_THRESHOLD`. Neither field is overwritten once set — `COALESCE`
 * preserves the prior value on conflict.
 *
 * Called from the kosync write hook after a progress upsert, and from the
 * one-shot backfill maintenance job (which builds candidates from history).
 */
export async function upsertReadingAggregate(
  db: Db,
  apiKeyId: string,
  bookId: string,
  document: string,
): Promise<void> {
  const rows = await db
    .select({
      percentage: readingProgress.percentage,
      timestamp: readingProgress.timestamp,
    })
    .from(readingProgress)
    .where(and(eq(readingProgress.apiKeyId, apiKeyId), eq(readingProgress.document, document)));

  let startedTs: bigint | null = null;
  let finishedTs: bigint | null = null;
  for (const row of rows) {
    const pct = Number(row.percentage);
    if (Number.isNaN(pct)) continue;
    if (pct > 0 && (startedTs === null || row.timestamp < startedTs)) {
      startedTs = row.timestamp;
    }
    if (pct >= FINISHED_THRESHOLD && (finishedTs === null || row.timestamp < finishedTs)) {
      finishedTs = row.timestamp;
    }
  }

  if (startedTs === null && finishedTs === null) return;

  const startedAt = startedTs !== null ? new Date(Number(startedTs) * 1000) : null;
  const finishedAt = finishedTs !== null ? new Date(Number(finishedTs) * 1000) : null;

  await db
    .insert(readingAggregate)
    .values({ apiKeyId, bookId, startedAt, finishedAt })
    .onConflictDoUpdate({
      target: [readingAggregate.apiKeyId, readingAggregate.bookId],
      set: {
        startedAt: sql`COALESCE(${readingAggregate.startedAt}, EXCLUDED.started_at)`,
        finishedAt: sql`COALESCE(${readingAggregate.finishedAt}, EXCLUDED.finished_at)`,
        updatedAt: new Date(),
      },
    });
}
