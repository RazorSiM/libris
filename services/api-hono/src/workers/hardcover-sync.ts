import { and, eq } from "drizzle-orm";
import { hardcoverSyncLog, serviceCredentials, users } from "#db";
import type { Job } from "bullmq";
import {
  computeReadingStatus,
  HARDCOVER_STATUS_MAP,
  type ReadingStatus,
} from "../lib/reading-status";
import { matchBooksToHardcover, backfillEditionPageCounts } from "../lib/hardcover/matching";
import { pullHardcoverStatusesForUser } from "../lib/hardcover/pull-status";
import { findBooksToSyncToHardcover } from "../lib/hardcover/sync-candidates";
import {
  verifyToken,
  upsertUserBook,
  upsertUserBookRead,
  updateUserBookRead,
  getEditionPages,
} from "../lib/hardcover/client";
import { unsealToken } from "../shared/auth.js";
import { getDb } from "../services/db.js";
import { getEnv } from "../env.js";
import { isHardcoverMetadataEnabled, isHardcoverSyncEnabled } from "../services/settings.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("worker:hardcover-sync");
const MAX_RATE_LIMIT_RETRIES = 5;
/** Delay between per-user syncs to respect Hardcover's 60 req/min rate limit */
const INTER_USER_DELAY_MS = 5_000;

interface ValidatedUser {
  userId: string;
  token: string;
  username: string;
  /** Libris role, from the Better Auth admin plugin. Nullable upstream. */
  role: string | null;
  /** Account creation time — the tiebreak that keeps the pick stable. */
  accountCreatedAt: Date;
}

export function shouldRunGlobalMetadata(metadataEnabled: boolean, manual: boolean): boolean {
  return metadataEnabled && !manual;
}

/**
 * Whose Hardcover quota funds the scheduled install-wide phase.
 *
 * ISBN matching and the page-count backfill run once per scheduled sync over
 * the whole catalog, not over one person's shelf, so their cost has no natural
 * owner. It used to fall on `validUsers[0]` — whichever connected user the
 * credential query happened to return first — which billed install-wide work to
 * an arbitrary member and moved between runs as rows were added or removed.
 *
 * An admin is the closest thing a self-hosted install has to an owner, so the
 * phase spends an admin's quota. The oldest admin account wins, with the user
 * id as a tiebreak, so the same token is picked every run rather than shifting
 * under concurrent signups.
 *
 * Returns null when no admin has connected Hardcover. The caller must then skip
 * the phase: falling back to any other token would put the cost straight back
 * on an arbitrary member in exactly the case this exists to prevent.
 */
export function selectGlobalMetadataUser<
  T extends { userId: string; role: string | null; accountCreatedAt: Date },
>(candidates: readonly T[]): T | null {
  // Matches shared/auth.ts isAdmin() and the admin plugin's adminRoles config.
  const admins = candidates.filter((candidate) => candidate.role === "admin");
  if (admins.length === 0) return null;

  return admins.reduce((oldest, candidate) => {
    const delta = candidate.accountCreatedAt.getTime() - oldest.accountCreatedAt.getTime();
    if (delta !== 0) return delta < 0 ? candidate : oldest;
    return candidate.userId < oldest.userId ? candidate : oldest;
  });
}

export async function processHardcoverSync(job: Job): Promise<void> {
  const db = getDb();
  const env = getEnv();
  const targetApiKeyId: string | undefined = job.data?.userId;
  const manual = job.data?.manual === true;

  // 1. Load all hardcover credentials (or just one if manually triggered for a specific user)
  const credQuery = db
    .select({
      userId: serviceCredentials.userId,
      passwordHash: serviceCredentials.passwordHash,
      // Joined in because the scheduled install-wide phase is funded by an
      // admin's Hardcover quota — see selectGlobalMetadataUser.
      role: users.role,
      accountCreatedAt: users.createdAt,
    })
    .from(serviceCredentials)
    .innerJoin(users, eq(users.id, serviceCredentials.userId))
    .where(
      targetApiKeyId
        ? and(
            eq(serviceCredentials.service, "hardcover"),
            eq(serviceCredentials.userId, targetApiKeyId),
          )
        : eq(serviceCredentials.service, "hardcover"),
    );

  const creds = await credQuery;

  if (creds.length === 0) {
    log.info("No hardcover credentials configured, skipping sync");
    return;
  }

  // 2. Validate all tokens upfront, collect valid users
  const validUsers: ValidatedUser[] = [];
  for (const cred of creds) {
    const token = await unsealToken(cred.passwordHash, env.API_SECRET_KEY);
    if (!token) {
      log.warn(`Failed to decrypt Hardcover token for userId=${cred.userId}, skipping`);
      continue;
    }

    const verify = await verifyToken(token);
    if (!verify.ok) {
      log.warn(`Hardcover token invalid for userId=${cred.userId}: ${verify.error.type}, skipping`);
      continue;
    }

    log.info(`Authenticated userId=${cred.userId} as ${verify.data.username}`);
    validUsers.push({
      userId: cred.userId,
      token: token,
      username: verify.data.username,
      role: cred.role,
      accountCreatedAt: cred.accountCreatedAt,
    });
  }

  if (validUsers.length === 0) {
    log.warn("No valid Hardcover tokens found, skipping sync");
    return;
  }

  // Check feature toggles
  const [metadataEnabled, syncEnabled] = await Promise.all([
    isHardcoverMetadataEnabled(db),
    isHardcoverSyncEnabled(db),
  ]);

  if (!metadataEnabled && !syncEnabled) {
    log.info("Both Hardcover metadata and sync are disabled, skipping");
    return;
  }

  // 3. Phase 1: ISBN matching + backfill — runs once globally, over the whole
  // catalog, on an admin's Hardcover quota. Never on whichever user's
  // credential the query happened to return first: that billed install-wide
  // work to an arbitrary member and moved between runs.
  if (!metadataEnabled) {
    log.info("Hardcover metadata disabled, skipping ISBN matching phase");
  }
  if (manual && metadataEnabled) {
    log.info("Manual sync: skipping global ISBN matching and page-count backfill");
  }

  const globalUser = shouldRunGlobalMetadata(metadataEnabled, manual)
    ? selectGlobalMetadataUser(validUsers)
    : null;

  if (shouldRunGlobalMetadata(metadataEnabled, manual) && !globalUser) {
    // Deliberately no fallback. The failure path is exactly where an arbitrary
    // user's quota would get spent, so the phase stops instead.
    log.warn(
      "No admin has connected Hardcover; skipping the global ISBN matching and page-count backfill phase. " +
        "This install-wide phase spends an admin's Hardcover quota and never falls back to another user's token — " +
        "connect Hardcover on an admin account to re-enable it.",
    );
  }

  if (globalUser) {
    log.info(
      `Global ISBN matching and page-count backfill will spend the Hardcover quota of admin ` +
        `${globalUser.username} (userId=${globalUser.userId})`,
    );
  }

  const runGlobalMetadata = globalUser !== null;
  const globalToken = globalUser?.token;

  const matchResult =
    runGlobalMetadata && globalToken
      ? await matchBooksToHardcover(db, globalToken, {
          onProgress: (matched, total) => {
            void job.updateProgress({ phase: "matching", matched, total });
          },
        })
      : null;
  if (matchResult) {
    log.info(
      `ISBN matching: ${matchResult.matched} matched, ${matchResult.skipped} skipped, ${matchResult.failed} failed`,
    );
  }

  // 3b. Backfill page counts from Hardcover editions for already-matched books
  if (runGlobalMetadata && globalToken) {
    const backfillResult = await backfillEditionPageCounts(db, globalToken);
    if (backfillResult.updated > 0) {
      log.info(
        `Page count backfill: ${backfillResult.updated} updated, ${backfillResult.skipped} skipped, ${backfillResult.failed} failed`,
      );
    }
  }

  // 4. Phase 2: Sync reading progress per user (skip if disabled)
  if (!syncEnabled) {
    log.info("Hardcover sync disabled, skipping progress sync phase");
    return;
  }

  let totalSynced = 0;
  let totalSkipped = 0;

  for (let userIdx = 0; userIdx < validUsers.length; userIdx++) {
    const user = validUsers[userIdx];
    log.info(`Syncing progress for user ${user.username} (userId=${user.userId})`);

    // Phase 2a: pull statuses from Hardcover into reading_aggregate.external_status.
    // Done before push so the local effective status is up-to-date when computing
    // what to push out — though pulled statuses never feed the push path themselves.
    const pullResult = await pullHardcoverStatusesForUser(db, user.token, user.userId);
    if (pullResult.fetched > 0) {
      log.info(
        `[${user.username}] Pulled ${pullResult.fetched} Hardcover user_books, ` +
          `upserted ${pullResult.upserted} external_status (${pullResult.unknown} unknown status_id)`,
      );
    }

    const { synced, skipped } = await syncUserProgress(db, job, user);
    totalSynced += synced;
    totalSkipped += skipped;

    // Add delay between users to respect rate limits (60 req/min total)
    if (userIdx < validUsers.length - 1) {
      log.info(`Waiting ${INTER_USER_DELAY_MS}ms before next user...`);
      await new Promise((r) => setTimeout(r, INTER_USER_DELAY_MS));
    }
  }

  log.info(
    `Sync complete for ${validUsers.length} user(s): ${totalSynced} synced, ${totalSkipped} skipped`,
  );
}

/** Sync reading progress for a single user, scoped by their userId */
async function syncUserProgress(
  db: ReturnType<typeof getDb>,
  job: Job,
  user: ValidatedUser,
): Promise<{ synced: number; skipped: number }> {
  const { userId, token } = user;

  const booksToSync = await findBooksToSyncToHardcover(db, userId);

  log.info(`[${user.username}] Found ${booksToSync.length} books to sync`);

  let synced = 0;
  let skipped = 0;
  let rateLimitRetries = 0;

  for (let i = 0; i < booksToSync.length; i++) {
    const row = booksToSync[i];
    const percentage = row.max_percentage !== null ? Number(row.max_percentage) : null;
    const lastActivity = row.last_activity !== null ? new Date(row.last_activity) : null;
    const computed = computeReadingStatus(percentage, lastActivity);
    const status: ReadingStatus = (row.manual_status as ReadingStatus | null) ?? computed;
    const hardcoverStatusId = HARDCOVER_STATUS_MAP[status];

    // Never push "unread" to Hardcover — we either have no local reading data
    // and no manual override, or the user explicitly cleared their override.
    // Don't clobber whatever status they already have on Hardcover.
    if (status === "unread") {
      log.debug(`[${user.username}] Skipping "${row.title}" — effective status is unread`);
      skipped++;
      continue;
    }

    try {
      // Upsert user book (status)
      const ubResult = await upsertUserBook(token, {
        bookId: row.hardcover_book_id,
        statusId: hardcoverStatusId,
      });

      if (!ubResult.ok) {
        if (ubResult.error.type === "rate_limited") {
          rateLimitRetries++;
          if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.error(
              `[${user.username}] Rate limit retries exhausted (${MAX_RATE_LIMIT_RETRIES}) while syncing "${row.title}", aborting user sync`,
            );
            break;
          }
          log.warn(
            `[${user.username}] Rate limited (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), pausing 60s...`,
          );
          await new Promise((r) => setTimeout(r, 60_000));
          i--;
          continue;
        }
        log.warn(
          `[${user.username}] Failed to sync "${row.title}": ${ubResult.error.type} - ${ubResult.error.type === "api_error" ? ubResult.error.message : ""}`,
        );
        skipped++;
        continue;
      }

      const userBookId = ubResult.data.userBookId;

      // Push reading progress. Hardcover tracks progress as a page number, so we
      // convert our percentage using the edition's page count (preferred over
      // local page_count, which may come from EPUB metadata for a different
      // edition). When the matched edition has no page count we can't express
      // page-level progress — but we still record the read (with start/finish
      // dates) so the book stops being a perpetual sync candidate and its dates
      // reach Hardcover. This is the fix for editions with a null `pages` field.
      let progressSynced = false;
      const progressNeeded =
        percentage !== null && percentage > 0 && row.hardcover_edition_id !== null;

      if (progressNeeded) {
        const editionPagesResult = await getEditionPages(token, row.hardcover_edition_id!);

        if (!editionPagesResult.ok) {
          // A transient fetch error (rate limit / network) must NOT be treated
          // as "no pages" — otherwise we'd mark the book synced and never push
          // its real progress.
          if (editionPagesResult.error.type === "rate_limited") {
            rateLimitRetries++;
            if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
              log.error(
                `[${user.username}] Rate limit retries exhausted while fetching edition pages for "${row.title}", aborting user sync`,
              );
              break;
            }
            log.warn(
              `[${user.username}] Rate limited fetching edition pages (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), pausing 60s...`,
            );
            await new Promise((r) => setTimeout(r, 60_000));
            i--;
            continue;
          }
          // Non-retryable error: skip progress this run, leave the book a
          // candidate (last_progress stays unsynced) so it retries next sync.
          log.warn(
            `[${user.username}] "${row.title}": failed to fetch edition pages (${editionPagesResult.error.type}); will retry progress next sync`,
          );
        } else {
          const editionPages = editionPagesResult.data;
          if (editionPages === null) {
            log.warn(
              `[${user.username}] "${row.title}": Hardcover edition ${row.hardcover_edition_id} has no page count; syncing read dates without page progress`,
            );
          }

          const startedAt = row.first_activity
            ? new Date(row.first_activity).toISOString().slice(0, 10)
            : undefined;
          const finishedAt =
            status === "finished" && row.last_activity
              ? new Date(row.last_activity).toISOString().slice(0, 10)
              : undefined;
          const progressPages =
            editionPages !== null ? Math.round(percentage! * editionPages) : undefined;

          try {
            if (row.hardcover_read_id) {
              const upd = await updateUserBookRead(token, {
                readId: row.hardcover_read_id,
                progressPages,
                editionId: row.hardcover_edition_id ?? undefined,
                startedAt,
                finishedAt,
              });
              progressSynced = upd.ok;
            } else {
              const readResult = await upsertUserBookRead(token, {
                userBookId,
                progressPages,
                editionId: row.hardcover_edition_id ?? undefined,
                startedAt,
                finishedAt,
              });
              if (readResult.ok) {
                row.hardcover_read_id = readResult.data.readId;
                progressSynced = true;
              }
            }
          } catch (err) {
            log
              .withMetadata({ error: String(err) })
              .warn(`[${user.username}] Failed to push reading progress for "${row.title}"`);
          }
        }
      }

      // Record last_progress only when there was nothing to push or the push
      // succeeded. If a push was needed but failed, leave it null so the book
      // stays a candidate and retries next run rather than being marked done.
      const lastProgress =
        !progressNeeded || progressSynced ? (percentage?.toFixed(4) ?? null) : null;

      // Upsert sync log — scoped to this user via composite unique (userId, bookId).
      // Always written after a successful status push (even when page progress
      // couldn't be synced) so a book is never stuck as a perpetual candidate.
      const now = new Date();
      await db
        .insert(hardcoverSyncLog)
        .values({
          bookId: row.book_id,
          userId,
          hardcoverUserBookId: userBookId,
          hardcoverReadId: row.hardcover_read_id,
          lastStatus: status,
          lastProgress,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [hardcoverSyncLog.userId, hardcoverSyncLog.bookId],
          set: {
            hardcoverUserBookId: userBookId,
            hardcoverReadId: row.hardcover_read_id,
            lastStatus: status,
            lastProgress,
            lastSyncedAt: now,
          },
        });

      synced++;
      log.info(
        `[${user.username}] Synced "${row.title}" → status=${status}, progress=${percentage}`,
      );
    } catch (err) {
      log
        .withMetadata({ error: String(err) })
        .error(`[${user.username}] Error syncing "${row.title}"`);
      skipped++;
    }

    // Reset per-book rate limit budget when moving to the next book.
    // The rate-limit retry path uses i--/continue and skips this reset,
    // so retries accumulate only within the same book.
    rateLimitRetries = 0;

    void job.updateProgress({
      phase: "syncing",
      user: user.username,
      synced,
      total: booksToSync.length,
    });

    // Throttle: ~1.2s between requests to stay safely under 60/min
    if (i < booksToSync.length - 1) {
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  log.info(`[${user.username}] Sync complete: ${synced} synced, ${skipped} skipped`);
  return { synced, skipped };
}
