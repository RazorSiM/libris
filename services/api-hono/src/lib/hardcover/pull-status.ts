import { inArray } from "drizzle-orm";
import { books, readingAggregate } from "#db";
import type { Db } from "#db";
import type { ReadingStatus } from "../reading-status.js";
import { getUserBooks, type HardcoverUserBook } from "./client.js";
import { getLogger } from "../logger.js";

const log = getLogger("hardcover:pull-status");

/**
 * Hardcover status_id → Libris ReadingStatus.
 * 1=Want to Read, 2=Currently Reading, 3=Read, 4=Paused, 5=Did Not Finish.
 * DNF folds into "paused" since Libris doesn't model abandonment separately.
 * Unknown ids return null and are skipped.
 */
export function mapHardcoverStatus(statusId: number): ReadingStatus | null {
  switch (statusId) {
    case 1:
      return "unread";
    case 2:
      return "reading";
    case 3:
      return "finished";
    case 4:
    case 5:
      return "paused";
    default:
      return null;
  }
}

export interface PullStatusResult {
  fetched: number;
  matched: number;
  upserted: number;
  unknown: number;
}

/**
 * Pull the user's Hardcover statuses and upsert them into
 * `reading_aggregate.external_status` for any local book matched by
 * `hardcover_book_id`. Manual overrides and dates are left untouched.
 */
export async function pullHardcoverStatusesForUser(
  db: Db,
  token: string,
  apiKeyId: string,
): Promise<PullStatusResult> {
  const userBooksResult = await getUserBooks(token);
  if (!userBooksResult.ok) {
    log.warn(`Failed to fetch user_books: ${userBooksResult.error.type}`);
    return { fetched: 0, matched: 0, upserted: 0, unknown: 0 };
  }

  const userBooks: HardcoverUserBook[] = userBooksResult.data;
  if (userBooks.length === 0) {
    return { fetched: 0, matched: 0, upserted: 0, unknown: 0 };
  }

  const hardcoverIds = userBooks.map((u) => u.bookId);
  const localBooks = await db
    .select({ id: books.id, hardcoverBookId: books.hardcoverBookId })
    .from(books)
    .where(inArray(books.hardcoverBookId, hardcoverIds));

  const hardcoverIdToLocalId = new Map<number, string>();
  for (const row of localBooks) {
    if (row.hardcoverBookId !== null) {
      hardcoverIdToLocalId.set(row.hardcoverBookId, row.id);
    }
  }

  let upserted = 0;
  let unknown = 0;
  const now = new Date();

  for (const userBook of userBooks) {
    const localBookId = hardcoverIdToLocalId.get(userBook.bookId);
    if (!localBookId) continue;

    const status = mapHardcoverStatus(userBook.statusId);
    if (!status) {
      unknown++;
      continue;
    }

    await db
      .insert(readingAggregate)
      .values({
        apiKeyId,
        bookId: localBookId,
        externalStatus: status,
        externalStatusSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [readingAggregate.apiKeyId, readingAggregate.bookId],
        set: {
          externalStatus: status,
          externalStatusSyncedAt: now,
          updatedAt: now,
        },
      });

    upserted++;
  }

  return {
    fetched: userBooks.length,
    matched: hardcoverIdToLocalId.size,
    upserted,
    unknown,
  };
}
