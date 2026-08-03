import { accessSync, constants } from "node:fs";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { getLogger } from "./lib/logger.js";
import { and, eq, lt, sql } from "drizzle-orm";
import { createDb, type Db } from "#db";
import { bookFiles, books } from "#db";
import { runMigrations } from "#db/migrate";
import {
  QUEUE_DB_MAINTENANCE,
  QUEUE_BOOK_DETECTED,
  QUEUE_BOOK_FETCH_METADATA,
  QUEUE_BOOK_ORGANIZE,
  QUEUE_BOOK_PARSE_FILE,
  QUEUE_HARDCOVER_SYNC,
  QUEUE_PROGRESS_HISTORY_CLEANUP,
} from "./lib/queue/constants.js";
import { createBookDetectedProcessor } from "./workers/book-detected.js";
import { createBookParseFileProcessor } from "./workers/book-parse-file.js";
import { processBookFetchMetadata } from "./workers/book-fetch-metadata.js";
import { processBookOrganize } from "./workers/book-organize.js";
import { processHardcoverSync } from "./workers/hardcover-sync.js";
import { processProgressHistoryCleanup } from "./workers/progress-history-cleanup.js";
import { createCleanupOrphanedFilesProcessor } from "./workers/cleanup-orphaned-files.js";
import { createInboxWatcher } from "./shared/inbox-watcher.js";
import { publishEvent } from "./services/event-bus.js";
import { parseRedisUrl, type Env } from "./env.js";
import type { Queues } from "./context.js";
import { getQueues, registerQueue } from "./services/queue.js";
import { setWorkers } from "./services/workers.js";
import { getDb } from "./services/db.js";
import { getSharedRedis, getRequestRedis, closeSharedRedis } from "./services/redis.js";
import { createRedisKVStore, createMemoryKVStore, type KVStore } from "./services/kv-store.js";
import {
  createMemorySecondaryStorage,
  createRedisSecondaryStorage,
} from "./services/auth-secondary-storage.js";
import { createAuth, type Auth } from "./lib/auth.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

// Cron schedules — modify here to change job timing
const CRON = {
  DAILY_CLEANUP: "0 3 * * *", // 3:00 AM daily
  HARDCOVER_SYNC: "0 4 * * *", // 4:00 AM daily
  MAINTENANCE: "0 3 * * *", // 3:00 AM daily
  CLEANUP_JOBS: "0 * * * *", // top of every hour
} as const;

export interface AppServices {
  db: Db;
  queues: Queues;
  redisStorage: KVStore;
  cacheStorage: KVStore;
  auth: Auth;
  shutdown: () => Promise<void>;
}

function validateDirectoryAccess(envName: string, dirPath: string): void {
  try {
    accessSync(dirPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`Directory for ${envName} is not accessible or writable: ${dirPath}`);
  }
}

export async function bootstrap(env: Env): Promise<AppServices> {
  const isTest = env.NODE_ENV === "test";
  const isDev = env.NODE_ENV === "development";
  const logger = getLogger("bootstrap");

  // 1. Validate directory access
  if (!isTest) {
    validateDirectoryAccess("LIBRIS_INBOX_PATH", env.LIBRIS_INBOX_PATH);
    validateDirectoryAccess("LIBRIS_LIBRARY_PATH", env.LIBRIS_LIBRARY_PATH);

    if (env.E2E_TEST === "1" && env.NODE_ENV === "production") {
      throw new Error("E2E_TEST=1 is not allowed in NODE_ENV=production");
    }
  }

  // 2. Run migrations (skip in test — tests use PGlite with manual migration)
  if (!isTest) {
    logger.info("Running database migrations...");
    await runMigrations(env.DATABASE_URL, env.MIGRATIONS_PATH);
    logger.info("Migrations applied.");
  }

  // 3. Create DB singleton
  const db = createDb(env.DATABASE_URL);

  // 4. Setup KV stores (memory in dev/test, Redis-backed in production)
  let redisStorage: KVStore;
  let cacheStorage: KVStore;
  // Better Auth's session and rate-limit store. Same dev/prod split as the KV
  // stores above, and in production it shares the one ioredis connection rather
  // than opening another.
  let authStorage: ReturnType<typeof createMemorySecondaryStorage>;

  if (isDev || isTest) {
    redisStorage = createMemoryKVStore();
    cacheStorage = createMemoryKVStore();
    authStorage = createMemorySecondaryStorage();
  } else {
    const requestRedis = getRequestRedis();
    redisStorage = createRedisKVStore(requestRedis, "kv");
    cacheStorage = createRedisKVStore(requestRedis, "cache");
    authStorage = createRedisSecondaryStorage(requestRedis, "ba");
    logger.info("Redis request-path stores mounted (bounded connection).");
  }

  const auth = createAuth({
    db,
    secondaryStorage: authStorage,
    env,
    secret: env.BETTER_AUTH_SECRET,
    // Empty means "infer from the request", which is what production needs
    // behind a TLS-terminating proxy.
    baseURL: env.BETTER_AUTH_URL || undefined,
  });

  // 5. Create BullMQ queues (reuse the shared ioredis instance via getQueues())
  const queues = isTest
    ? ({
        bookDetected: { add: async () => ({}) },
        bookParseFile: { add: async () => ({}) },
        bookFetchMetadata: { add: async () => ({}) },
        bookOrganize: { add: async () => ({}) },
        close: async () => {},
      } as Queues)
    : getQueues();

  // 6. Start inbox file watcher (skip in test)
  let watcherClose: (() => Promise<void>) | null = null;
  if (!isTest) {
    const watcher = createInboxWatcher(env.LIBRIS_INBOX_PATH, queues.bookDetected as Queue);
    watcherClose = () => watcher.close();
    logger.info("Inbox watcher started.");
  }

  // 7. Start BullMQ workers + schedulers (skip in test)
  const allWorkers: Worker[] = [];
  const schedulerQueues: Queue[] = [];

  if (!isTest) {
    const connection = parseRedisUrl(env.REDIS_URL);
    const workerLogger = getLogger("worker:plugin");
    workerLogger.info("Starting BullMQ workers...");

    // Reuse queue singletons from getQueues() for pipeline chaining —
    // no duplicate Queue instances needed.
    const appQueues = getQueues();

    // Pipeline workers — lockDuration sets stall detection window per worker type
    allWorkers.push(
      new Worker(
        QUEUE_BOOK_DETECTED,
        createBookDetectedProcessor(appQueues.bookParseFile as Queue),
        {
          connection,
          concurrency: 3,
          lockDuration: 60_000,
          stalledInterval: 30_000,
          maxStalledCount: 2,
        },
      ),
      new Worker(
        QUEUE_BOOK_PARSE_FILE,
        createBookParseFileProcessor(appQueues.bookFetchMetadata as Queue),
        {
          connection,
          concurrency: 2,
          lockDuration: 120_000,
          stalledInterval: 30_000,
          maxStalledCount: 2,
        },
      ),
      new Worker(QUEUE_BOOK_FETCH_METADATA, processBookFetchMetadata, {
        connection,
        concurrency: 3,
        lockDuration: 120_000,
        stalledInterval: 30_000,
        maxStalledCount: 2,
      }),
      new Worker(QUEUE_BOOK_ORGANIZE, processBookOrganize, {
        connection,
        concurrency: 1,
        lockDuration: 300_000,
        stalledInterval: 60_000,
        maxStalledCount: 2,
      }),
    );

    // Scheduled: progress history cleanup (daily 3:00 AM)
    // Use shared Redis for the scheduler queue
    const sharedRedis = getSharedRedis();
    const progressCleanupQueue = new Queue(QUEUE_PROGRESS_HISTORY_CLEANUP, {
      connection: sharedRedis as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      },
    });
    await progressCleanupQueue.upsertJobScheduler("daily-cleanup", { pattern: CRON.DAILY_CLEANUP });
    allWorkers.push(
      new Worker(QUEUE_PROGRESS_HISTORY_CLEANUP, processProgressHistoryCleanup, {
        connection,
        concurrency: 1,
        lockDuration: 300_000,
        stalledInterval: 60_000,
        maxStalledCount: 1,
      }),
    );

    // Scheduled: hardcover sync (daily 4:00 AM)
    const hardcoverSyncQueue = new Queue(QUEUE_HARDCOVER_SYNC, {
      connection: sharedRedis as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      },
    });
    await hardcoverSyncQueue.upsertJobScheduler("hardcover-daily-sync", {
      pattern: CRON.HARDCOVER_SYNC,
    });
    const hardcoverSyncWorker = new Worker(QUEUE_HARDCOVER_SYNC, processHardcoverSync, {
      connection,
      concurrency: 1,
      lockDuration: 600_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    });
    hardcoverSyncWorker.on("progress", (job, progress) => {
      publishEvent({
        type: "hardcover:sync-progress",
        payload: progress as Record<string, unknown>,
      }).catch((err) =>
        workerLogger
          .withMetadata({ error: String(err) })
          .warn("Failed to publish sync-progress event"),
      );
    });
    allWorkers.push(hardcoverSyncWorker);

    // Scheduled: cleanup stale inbox (daily 3:00 AM) + orphaned files (daily 3:00 AM) + completed jobs (hourly)
    const maintenanceQueue = new Queue(QUEUE_DB_MAINTENANCE, {
      connection: sharedRedis as unknown as ConnectionOptions,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 50 },
      },
    });
    await maintenanceQueue.upsertJobScheduler("cleanup-stale-inbox", { pattern: CRON.MAINTENANCE });
    await maintenanceQueue.upsertJobScheduler("cleanup-orphaned-files", {
      pattern: CRON.MAINTENANCE,
    });
    await maintenanceQueue.upsertJobScheduler("cleanup-completed-jobs", {
      pattern: CRON.CLEANUP_JOBS,
    });

    // One-time: rebuild missing book_files + recompute content hashes
    await maintenanceQueue.add("rebuild-book-files", {}, { jobId: "rebuild-book-files-v1" });
    await maintenanceQueue.add(
      "backfill-content-hashes",
      {},
      { jobId: "backfill-content-hashes-v2" },
    );
    // One-time: derive reading_aggregate from reading_progress_history.
    // The continuous kosync hook keeps it fresh going forward; this seeds
    // existing finished/in-progress books so they appear in clients without
    // requiring a fresh progress event.
    await maintenanceQueue.add(
      "backfill-reading-aggregate",
      {},
      { jobId: "backfill-reading-aggregate-v1" },
    );
    // One-time: link reading_progress rows that were orphaned (book_id NULL)
    // because their document hash didn't resolve when the progress arrived —
    // e.g. progress pushed before the book was organized. Recovers existing
    // rows so they become visible to Hardcover sync and status views.
    await maintenanceQueue.add("link-orphan-progress", {}, { jobId: "link-orphan-progress-v1" });

    const cleanupOrphanedFiles = createCleanupOrphanedFilesProcessor(env.LIBRIS_LIBRARY_PATH);

    allWorkers.push(
      new Worker(
        QUEUE_DB_MAINTENANCE,
        async (job) => {
          const taskDb = getDb();
          if (job.name === "cleanup-stale-inbox") {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const stale = await taskDb
              .delete(books)
              .where(and(eq(books.status, "inbox"), lt(books.updatedAt, cutoff)))
              .returning({ id: books.id });
            return { result: `Removed ${stale.length} stale inbox books` };
          }
          if (job.name === "cleanup-orphaned-files") {
            return cleanupOrphanedFiles(job);
          }
          if (job.name === "cleanup-completed-jobs") {
            const cleanupQueues = getQueues();
            const { close: _, ...qs } = cleanupQueues;
            const gracePeriod = 7 * 24 * 60 * 60 * 1000;
            let total = 0;
            for (const q of Object.values(qs)) {
              const removed = await (q as Queue).clean(gracePeriod, 1000, "completed");
              total += removed.length;
            }
            return { result: `Pruned ${total} completed jobs` };
          }
          if (job.name === "backfill-content-hashes") {
            const contentHashMod = await import("./lib/content-hash.js");
            const pathMod = await import("node:path");
            const fsMod = await import("node:fs/promises");
            const libraryPath = await fsMod.realpath(env.LIBRIS_LIBRARY_PATH);

            const files = await taskDb
              .select({
                id: bookFiles.id,
                storagePath: bookFiles.storagePath,
                contentHash: bookFiles.contentHash,
              })
              .from(bookFiles)
              .innerJoin(books, eq(bookFiles.bookId, books.id))
              .where(eq(books.status, "organized"));

            let updated = 0;
            for (const file of files) {
              if (!file.storagePath) continue;
              const fullPath = pathMod.resolve(pathMod.join(libraryPath, file.storagePath));
              try {
                const newHash = await contentHashMod.computePartialMd5(fullPath);
                if (newHash !== file.contentHash) {
                  await taskDb
                    .update(bookFiles)
                    .set({ contentHash: newHash })
                    .where(eq(bookFiles.id, file.id));
                  updated++;
                }
              } catch {
                // File missing — skip
              }
            }
            return { result: `Recomputed ${updated}/${files.length} content hashes` };
          }
          if (job.name === "rebuild-book-files") {
            const fsMod3 = await import("node:fs/promises");
            const pathMod3 = await import("node:path");
            const libraryRoot3 = await fsMod3.realpath(env.LIBRIS_LIBRARY_PATH);

            // Find organized books with no book_files
            const orphanedBooks = await taskDb.execute<{
              id: string;
              title: string | null;
              author: string | null;
            }>(sql`
              SELECT b.id, b.title, b.author
              FROM ${books} b
              LEFT JOIN ${bookFiles} bf ON bf.book_id = b.id
              WHERE b.status = 'organized' AND bf.id IS NULL
            `);

            const rows = orphanedBooks as unknown as Array<{
              id: string;
              title: string | null;
              author: string | null;
            }>;

            let rebuilt = 0;
            for (const row of rows) {
              const author = row.author || "Unknown Author";
              const title = row.title || "Unknown Title";
              const safeAuthor = author
                .replace(/[/:?*"<>|\\]/g, "_")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200);
              const safeTitle = title
                .replace(/[/:?*"<>|\\]/g, "_")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 200);
              const bookDir = pathMod3.join(libraryRoot3, safeAuthor, safeTitle);

              let dirEntries: string[];
              try {
                dirEntries = await fsMod3.readdir(bookDir);
              } catch {
                continue;
              }

              for (const entry of dirEntries) {
                const ext = pathMod3.extname(entry).toLowerCase();
                if (ext !== ".epub") continue;
                const storagePath = pathMod3.join(safeAuthor, safeTitle, entry);
                const fullPath = pathMod3.join(libraryRoot3, storagePath);
                const stat = await fsMod3.stat(fullPath);
                const contentHashMod3 = await import("./lib/content-hash.js");
                const contentHash = await contentHashMod3.computePartialMd5(fullPath);
                await taskDb.insert(bookFiles).values({
                  bookId: row.id,
                  format: ext.slice(1),
                  originalName: entry,
                  storagePath,
                  fileSize: stat.size,
                  contentHash,
                });
                rebuilt++;
              }
            }
            return { result: `Rebuilt ${rebuilt} book_files for ${rows.length} orphaned books` };
          }
          if (job.name === "backfill-reading-aggregate") {
            // Derive lifecycle timestamps from history. Single INSERT...SELECT;
            // ON CONFLICT DO NOTHING leaves any rows already maintained by the
            // kosync hook untouched.
            const result = await taskDb.execute<{ inserted: string }>(sql`
              WITH agg AS (
                SELECT
                  user_id,
                  book_id,
                  to_timestamp(MIN("timestamp") FILTER (WHERE percentage::numeric > 0)) AS started_at,
                  to_timestamp(MIN("timestamp") FILTER (WHERE percentage::numeric >= 0.95)) AS finished_at
                FROM reading_progress_history
                WHERE book_id IS NOT NULL AND user_id IS NOT NULL
                GROUP BY user_id, book_id
                HAVING MIN("timestamp") FILTER (WHERE percentage::numeric > 0) IS NOT NULL
              )
              INSERT INTO reading_aggregate (user_id, book_id, started_at, finished_at)
              SELECT user_id, book_id, started_at, finished_at FROM agg
              ON CONFLICT (user_id, book_id) DO NOTHING
              RETURNING id
            `);
            const rows = result as unknown as { id: string }[];
            return { result: `Backfilled ${rows.length} reading_aggregate rows` };
          }
          if (job.name === "link-orphan-progress") {
            const { reconcileOrphanProgressBookIds } = await import("./lib/progress-linking.js");
            const { progress, history } = await reconcileOrphanProgressBookIds(taskDb);
            return {
              result: `Linked ${progress} reading_progress + ${history} history rows to books`,
            };
          }
        },
        {
          connection,
          concurrency: 1,
          lockDuration: 600_000,
          stalledInterval: 60_000,
          maxStalledCount: 1,
        },
      ),
    );

    schedulerQueues.push(progressCleanupQueue, hardcoverSyncQueue, maintenanceQueue);

    // Register all queues in the global registry for the jobs browser
    for (const q of schedulerQueues) {
      registerQueue(q);
    }
    const { close: _closeQueues, ...pipelineQueues } = queues;
    for (const q of Object.values(pipelineQueues)) {
      registerQueue(q as Queue);
    }

    // Event hooks for all workers
    const queueEventMap: Record<string, string> = {
      [QUEUE_BOOK_DETECTED]: "book:detected",
      [QUEUE_BOOK_PARSE_FILE]: "book:parsed",
      [QUEUE_BOOK_FETCH_METADATA]: "book:metadata-ready",
      [QUEUE_BOOK_ORGANIZE]: "book:organized",
      [QUEUE_HARDCOVER_SYNC]: "hardcover:sync-complete",
    };

    for (const worker of allWorkers) {
      worker.on("completed", (job) => {
        workerLogger.info(`Job ${job.id} completed on queue ${job.queueName}`);
        const eventType = queueEventMap[job.queueName];
        if (eventType) {
          const bookId = (job.data as Record<string, unknown>)?.bookId as string | undefined;
          publishEvent({ type: eventType, bookId }).catch((e) =>
            workerLogger
              .withMetadata({ error: String(e) })
              .warn(`Failed to publish ${eventType} event`),
          );
        }
      });
      worker.on("failed", (job, err) => {
        if (job && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
          workerLogger.error(
            `Job ${job.id} permanently failed on ${job.queueName} after ${job.attemptsMade} attempts: ${err.message}`,
          );
          const bookId = (job.data as Record<string, unknown>)?.bookId as string | undefined;
          publishEvent({
            type: "job:failed",
            bookId,
            payload: { queue: job.queueName, error: err.message, jobId: job.id },
          }).catch((e) =>
            workerLogger
              .withMetadata({ error: String(e) })
              .warn("Failed to publish job:failed event"),
          );
        }
      });
      worker.on("error", (err) => workerLogger.error(`Worker error: ${err.message}`));
      worker.on("stalled", (jobId) => workerLogger.warn(`Job ${jobId} stalled`));
    }

    setWorkers(allWorkers);
    workerLogger.info(`Started ${allWorkers.length} workers`);
  }

  // 8. Shutdown handler
  const shutdown = async () => {
    logger.info("Shutting down...");

    const shutdownPromise = Promise.all([
      ...allWorkers.map((w) => w.close()),
      ...schedulerQueues.map((q) => q.close()),
      queues.close(),
    ]);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Worker shutdown timed out after 30s")),
        SHUTDOWN_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([shutdownPromise, timeout]);
    } catch (err) {
      logger.withMetadata({ error: String(err) }).error("Forced shutdown");
      await Promise.allSettled([
        ...allWorkers.map((w) => w.close(true)),
        ...schedulerQueues.map((q) => q.close()),
      ]);
    }

    if (watcherClose) await watcherClose();

    const { closeEventBus } = await import("./services/event-bus.js");
    await closeEventBus();

    // Close the shared Redis connection (used by queues, KV, event-bus pub)
    await closeSharedRedis();

    // Close database connection pool
    await db.$client.end({ timeout: 5 }).catch(() => {});

    logger.info("Shutdown complete.");
  };

  return { db, queues, redisStorage, cacheStorage, auth, shutdown };
}
