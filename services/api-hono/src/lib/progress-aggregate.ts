import { and, eq } from "drizzle-orm";
import { readingAggregate, readingProgress } from "#db";
import type { Db } from "#db";
import { computeReadingStatus, type ReadingStatus } from "./reading-status.js";

export interface ProgressAggregate {
  percentage: number | null;
  status: ReadingStatus | null;
  lastDevice: string | null;
  lastTimestamp: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  pausedAt: string | null;
  manuallySet: boolean;
  externallySet: boolean;
}

export function emptyProgressAggregate(): ProgressAggregate {
  return {
    percentage: null,
    status: "unread",
    lastDevice: null,
    lastTimestamp: null,
    startedAt: null,
    finishedAt: null,
    pausedAt: null,
    manuallySet: false,
    externallySet: false,
  };
}

interface ProgressRow {
  bookId: string | null;
  percentage: string;
  device: string;
  timestamp: bigint;
}

interface AggregateRow {
  bookId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  manualStatus: ReadingStatus | null;
  manualStartedAt: Date | null;
  manualFinishedAt: Date | null;
  manualPausedAt: Date | null;
  manualSetAt: Date | null;
  externalStatus: ReadingStatus | null;
  externalStatusSyncedAt: Date | null;
}

function pickHighestPercentage(rows: ProgressRow[]): {
  percentage: number;
  device: string;
  timestamp: number;
} | null {
  let best: { percentage: number; device: string; timestamp: number } | null = null;
  for (const row of rows) {
    const pct = Number(row.percentage);
    if (Number.isNaN(pct)) continue;
    if (best === null || pct > best.percentage) {
      best = { percentage: pct, device: row.device, timestamp: Number(row.timestamp) };
    }
  }
  return best;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() < b.getTime() ? a : b;
}

function combineAggregates(rows: AggregateRow[]): {
  startedAt: Date | null;
  finishedAt: Date | null;
  manualStatus: ReadingStatus | null;
  manualStartedAt: Date | null;
  manualFinishedAt: Date | null;
  manualPausedAt: Date | null;
  manualSetAt: Date | null;
  externalStatus: ReadingStatus | null;
} {
  let startedAt: Date | null = null;
  let finishedAt: Date | null = null;
  let manualStatus: ReadingStatus | null = null;
  let manualStartedAt: Date | null = null;
  let manualFinishedAt: Date | null = null;
  let manualPausedAt: Date | null = null;
  let manualSetAt: Date | null = null;
  let externalStatus: ReadingStatus | null = null;
  let externalSyncedAt: Date | null = null;
  for (const row of rows) {
    startedAt = earliest(startedAt, row.startedAt);
    finishedAt = earliest(finishedAt, row.finishedAt);
    if (
      row.manualSetAt &&
      (manualSetAt === null || row.manualSetAt.getTime() > manualSetAt.getTime())
    ) {
      manualStatus = row.manualStatus;
      manualStartedAt = row.manualStartedAt;
      manualFinishedAt = row.manualFinishedAt;
      manualPausedAt = row.manualPausedAt;
      manualSetAt = row.manualSetAt;
    }
    if (
      row.externalStatus &&
      row.externalStatusSyncedAt &&
      (externalSyncedAt === null ||
        row.externalStatusSyncedAt.getTime() > externalSyncedAt.getTime())
    ) {
      externalStatus = row.externalStatus;
      externalSyncedAt = row.externalStatusSyncedAt;
    }
  }
  return {
    startedAt,
    finishedAt,
    manualStatus,
    manualStartedAt,
    manualFinishedAt,
    manualPausedAt,
    manualSetAt,
    externalStatus,
  };
}

export function buildProgressAggregate(
  progressRows: ProgressRow[],
  aggregateRows: AggregateRow[],
): ProgressAggregate {
  const highest = pickHighestPercentage(progressRows);
  const combined = combineAggregates(aggregateRows);

  // Effective status precedence:
  //   manual_status (user override, also pushed to Hardcover)
  //   ?? local-computed (only when there is local progress data)
  //   ?? external_status (Hardcover-pulled fallback)
  //   ?? "unread"
  const localComputed: ReadingStatus | null = highest
    ? computeReadingStatus(highest.percentage, new Date(highest.timestamp * 1000))
    : null;

  const status: ReadingStatus =
    combined.manualStatus ?? localComputed ?? combined.externalStatus ?? "unread";
  const startedAt = combined.manualStartedAt ?? combined.startedAt;
  const finishedAt = combined.manualFinishedAt ?? combined.finishedAt;

  // externallySet is true when the effective status came from external_status —
  // i.e. no manual override and no local progress, but Hardcover gave us a status.
  const externallySet =
    combined.manualStatus === null && localComputed === null && combined.externalStatus !== null;

  return {
    percentage: highest?.percentage ?? null,
    status,
    lastDevice: highest?.device ?? null,
    lastTimestamp: highest?.timestamp ?? null,
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt?.toISOString() ?? null,
    pausedAt: combined.manualPausedAt?.toISOString() ?? null,
    manuallySet: combined.manualSetAt !== null,
    externallySet,
  };
}

/**
 * Fetch progress + aggregate rows for a single book and build the user-facing
 * aggregate. Used by GET /api/library/{id} and the manual-override endpoints.
 */
export async function buildProgressAggregateForBook(
  db: Db,
  bookId: string,
  userId: string,
): Promise<ProgressAggregate> {
  const [progressRows, aggregateRows] = await Promise.all([
    db
      .select({
        bookId: readingProgress.bookId,
        percentage: readingProgress.percentage,
        device: readingProgress.device,
        timestamp: readingProgress.timestamp,
      })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, userId))),
    db
      .select({
        bookId: readingAggregate.bookId,
        startedAt: readingAggregate.startedAt,
        finishedAt: readingAggregate.finishedAt,
        manualStatus: readingAggregate.manualStatus,
        manualStartedAt: readingAggregate.manualStartedAt,
        manualFinishedAt: readingAggregate.manualFinishedAt,
        manualPausedAt: readingAggregate.manualPausedAt,
        manualSetAt: readingAggregate.manualSetAt,
        externalStatus: readingAggregate.externalStatus,
        externalStatusSyncedAt: readingAggregate.externalStatusSyncedAt,
      })
      .from(readingAggregate)
      .where(and(eq(readingAggregate.bookId, bookId), eq(readingAggregate.userId, userId))),
  ]);

  return buildProgressAggregate(progressRows, aggregateRows);
}

/**
 * Batch variant for the bulk sync endpoint. Aggregates across all api keys —
 * the sync feed is library-wide rather than per-user (mirror clients show the
 * library to whichever user is reading the export).
 */
export function buildProgressAggregatesForBooks(
  bookIds: string[],
  progressRows: ProgressRow[],
  aggregateRows: AggregateRow[],
): Map<string, ProgressAggregate> {
  const progressByBook = new Map<string, ProgressRow[]>();
  for (const row of progressRows) {
    if (!row.bookId) continue;
    const arr = progressByBook.get(row.bookId) ?? [];
    arr.push(row);
    progressByBook.set(row.bookId, arr);
  }

  const aggregateByBook = new Map<string, AggregateRow[]>();
  for (const row of aggregateRows) {
    if (!row.bookId) continue;
    const arr = aggregateByBook.get(row.bookId) ?? [];
    arr.push(row);
    aggregateByBook.set(row.bookId, arr);
  }

  const out = new Map<string, ProgressAggregate>();
  for (const id of bookIds) {
    out.set(
      id,
      buildProgressAggregate(progressByBook.get(id) ?? [], aggregateByBook.get(id) ?? []),
    );
  }
  return out;
}
