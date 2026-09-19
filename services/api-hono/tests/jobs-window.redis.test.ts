/**
 * The jobs browser's windowing rules, against real BullMQ boards.
 *
 * `Queue.getJobs` ranges each requested status board independently, so the
 * bounded-window contract (exact totals, a capped per-board fetch, and a
 * `truncated` flag the caller can trust) is only meaningful against the real
 * implementation. The fake queues in tests/api.test.ts model the ideal case;
 * this suite seeds real waiting/delayed jobs and drives the real boards.
 *
 * As with the other backing-service suites, an absent Redis is a skip on a
 * developer machine and a hard failure in CI — a silently skipped suite here
 * is indistinguishable from coverage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Queue, Worker } from "bullmq";
import type { Job } from "bullmq";
import { collectBoardJobs, planJobWindow, sortJobWindow } from "../src/lib/queue/jobs-window.js";
import {
  announceSkip,
  isRedisReachable,
  SERVICES_ARE_REQUIRED,
  TEST_REDIS_URL,
} from "./backing-services.js";

const reachable = await isRedisReachable();

if (!reachable) {
  const why =
    `Redis at ${TEST_REDIS_URL} is unreachable, so the jobs windowing contract ` +
    `cannot be checked against real BullMQ boards. Start one with ` +
    `\`docker compose -f docker-compose.test.yml up -d --wait redis\`, or point ` +
    `LIBRIS_TEST_REDIS_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("jobs-window.redis.test.ts", why);
}

/** A BullMQ connection that satisfies its blocking-worker requirement. */
function connectionOptions() {
  const url = new URL(TEST_REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: null,
  };
}

/** Unique per run so parallel worktrees sharing one Redis cannot collide. */
const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `libris-jobs-test-${suffix}`;
const queueName = `window-${suffix}`;

function serialize(job: Job, boardQueue: string, status: string) {
  return { id: job.id!, queueName: boardQueue, timestamp: job.timestamp, status };
}

describe.skipIf(!reachable)("jobs windowing against real BullMQ boards", () => {
  let queue: Queue;

  beforeAll(() => {
    queue = new Queue(queueName, { connection: connectionOptions(), prefix });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
  });

  it("serves page 11 of 201 real waiting jobs", async () => {
    await queue.addBulk(
      Array.from({ length: 201 }, (_, i) => ({
        name: "bulk",
        data: { i },
        opts: { jobId: `w-${i}` },
      })),
    );

    const counts = await queue.getJobCounts("waiting");
    expect(counts.waiting).toBe(201);

    const plan = planJobWindow(11, 20, 1);
    const jobs = await collectBoardJobs([queue], ["waiting"], plan.depth, serialize);
    const windowJobs = sortJobWindow(jobs);
    expect(windowJobs).toHaveLength(201);

    // 201 jobs at 20/page: page 11 holds exactly the last one. Before the
    // window was fixed, only 200 jobs were fetched and this page was empty.
    const page11 = windowJobs.slice(plan.start, plan.start + 20);
    expect(page11).toHaveLength(1);

    const page1 = windowJobs.slice(0, 20);
    expect(page1).toHaveLength(20);
    expect(page1.map((job) => job.id)).not.toContain(page11[0]!.id);
  });

  it("bounds each board's fetch at the requested depth", async () => {
    const jobs = await collectBoardJobs([queue], ["waiting"], 50, serialize);
    expect(jobs).toHaveLength(50);
  });

  it("reads each status board separately and attributes its status", async () => {
    const delayedQueue = new Queue(`${queueName}-delayed`, {
      connection: connectionOptions(),
      prefix,
    });
    try {
      await delayedQueue.add("d", { i: 0 }, { jobId: "d-0", delay: 60_000 });

      const jobs = await collectBoardJobs(
        [queue, delayedQueue],
        ["waiting", "delayed"],
        10,
        serialize,
      );
      const ids = jobs.map((job) => job.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(jobs.filter((job) => job.status === "waiting")).toHaveLength(10);
      expect(jobs.filter((job) => job.status === "delayed").map((job) => job.id)).toEqual(["d-0"]);
    } finally {
      await delayedQueue.obliterate({ force: true }).catch(() => {});
      await delayedQueue.close();
    }
  });
});

describe.skipIf(!reachable)("queue drain against a real active job", () => {
  const drainQueueName = `drain-${suffix}`;
  let drainQueue: Queue;
  let worker: Worker;

  it("removes waiting and delayed jobs while leaving the active one", async () => {
    drainQueue = new Queue(drainQueueName, { connection: connectionOptions(), prefix });
    worker = new Worker(drainQueueName, async () => new Promise(() => {}), {
      connection: connectionOptions(),
      prefix,
    });

    try {
      await drainQueue.add("active-job", { i: 0 }, { jobId: "job-active" });
      await drainQueue.add("waiting-job", { i: 1 }, { jobId: "job-waiting" });
      await drainQueue.add("delayed-job", { i: 2 }, { jobId: "job-delayed", delay: 60_000 });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const counts = await drainQueue.getJobCounts("active", "waiting", "delayed");
        if ((counts.active ?? 0) === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await drainQueue.getJobCounts("active", "waiting", "delayed")).toMatchObject({
        active: 1,
        waiting: 1,
        delayed: 1,
      });

      await drainQueue.drain(true);

      expect(await drainQueue.getJobCounts("active", "waiting", "delayed")).toMatchObject({
        active: 1,
        waiting: 0,
        delayed: 0,
      });
    } finally {
      await worker.close(true);
      await drainQueue.obliterate({ force: true }).catch(() => {});
      await drainQueue.close();
    }
  }, 30_000);
});
