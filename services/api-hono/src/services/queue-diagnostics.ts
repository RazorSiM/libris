import Redis from "ioredis";
import type { Job, Queue } from "bullmq";
import { QUEUE_NAMES } from "../lib/queue/constants.js";
import type { Queues } from "../context.js";
import { parseRedisUrl } from "../env.js";
import { getAllQueues, getQueues } from "./queue.js";

export type QueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
};

export type FailedJob = {
  id: string;
  queueName: string;
  name: string;
  data: Record<string, unknown>;
  error: string;
  failedAt: number;
  attemptsMade: number;
  maxAttempts: number;
};

const COUNT_STATUSES = ["waiting", "active", "completed", "failed", "delayed", "paused"] as const;

export function getPipelineQueues(): Queue[] {
  const { close: _, ...queues } = getQueues();
  return Object.values(queues) as Queue[];
}

export function getRegisteredQueues(): Queue[] {
  const allQueues = getAllQueues();
  if (allQueues.size > 0) return [...allQueues.values()];
  return getPipelineQueues();
}

/**
 * Book ids with a pipeline job in flight (active, waiting or delayed).
 *
 * Queue counts are install-wide and cannot be attributed to a person, which is
 * how a non-admin's dashboard ended up reporting how many books *other* people
 * were having processed. Job ids can be attributed: intersect
 * these with `books.created_by` and the count becomes the caller's own.
 *
 * `bookDetected` is deliberately not scanned — its payload is a file path, and
 * the book row it will create does not exist yet, so there is no owner to
 * check. Anything a caller could see in that window is a file they have not
 * uploaded through the API.
 *
 * Takes the context `Queues` (rather than {@link getPipelineQueues}) so route
 * tests can inject them.
 */
export async function collectInFlightBookIds(queues: Queues): Promise<string[]> {
  const bookIds = new Set<string>();

  await Promise.all(
    [queues.bookParseFile, queues.bookFetchMetadata, queues.bookOrganize].map(async (queue) => {
      // BullMQ Queue objects expose getJobs at runtime; the minimal Queues
      // interface only declares `add`, so we cast here.
      const getJobs = (queue as unknown as Record<string, unknown>).getJobs as
        | ((states: string[]) => Promise<{ data?: { bookId?: string } }[]>)
        | undefined;
      if (!getJobs) return;

      const jobs = await getJobs.call(queue, ["active", "waiting", "delayed"]);
      for (const job of jobs) {
        if (job.data?.bookId) bookIds.add(job.data.bookId);
      }
    }),
  );

  return [...bookIds];
}

export async function collectQueueCounts(queues: Queue[]): Promise<Record<string, QueueCounts>> {
  const entries = await Promise.all(
    queues.map(async (queue) => {
      const counts = await queue.getJobCounts(...COUNT_STATUSES);
      return [queue.name, counts as QueueCounts] as const;
    }),
  );

  return Object.fromEntries(entries);
}

export async function collectFailedJobs(
  queues: Queue[],
): Promise<{ jobs: FailedJob[]; total: number }> {
  const failedJobs: FailedJob[] = [];

  await Promise.all(
    queues.map(async (queue) => {
      const jobs: Job[] = await queue.getJobs(["failed"]);
      for (const job of jobs) {
        failedJobs.push({
          id: job.id!,
          queueName: queue.name,
          name: job.name,
          data: job.data as Record<string, unknown>,
          error: job.failedReason ?? "Unknown error",
          failedAt: job.finishedOn ?? job.processedOn ?? job.timestamp,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts?.attempts ?? 1,
        });
      }
    }),
  );

  failedJobs.sort((a, b) => b.failedAt - a.failedAt);
  return { jobs: failedJobs, total: failedJobs.length };
}

async function deleteBullKeys(redis: Redis, pattern: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = nextCursor;

    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== "0");

  return deleted;
}

export async function resetBullMqState(
  redisUrl: string,
): Promise<{ deletedKeys: number; patterns: string[] }> {
  const options = parseRedisUrl(redisUrl);
  const redis = new Redis({
    ...options,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  const patterns = QUEUE_NAMES.map((name) => `bull:${name}:*`);

  try {
    await redis.connect();
    let deletedKeys = 0;

    for (const pattern of patterns) {
      deletedKeys += await deleteBullKeys(redis, pattern);
    }

    return { deletedKeys, patterns };
  } finally {
    await redis.quit().catch(() => {
      redis.disconnect();
    });
  }
}
