import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Queue } from "bullmq";
import {
  collectFailedJobs,
  collectQueueCounts,
  getRegisteredQueues,
  resetBullMqState,
} from "./queue-diagnostics.js";

vi.mock("./queue.js", () => ({
  getQueues: vi.fn(),
  getAllQueues: vi.fn(),
}));

vi.mock("ioredis", () => ({
  default: vi.fn(),
}));

const { getQueues, getAllQueues } = await import("./queue.js");
const Redis = (await import("ioredis")).default;

describe("queue diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects queue counts by queue name", async () => {
    const queueA = {
      name: "book-detected",
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 1,
        active: 2,
        completed: 3,
        failed: 4,
        delayed: 5,
      }),
      isPaused: vi.fn().mockResolvedValue(false),
    } as unknown as Queue;
    const queueB = {
      name: "book-organize",
      getJobCounts: vi.fn().mockResolvedValue({
        waiting: 0,
        active: 1,
        completed: 0,
        failed: 0,
        delayed: 0,
      }),
      // Paused queues keep their jobs in `waiting` — the flag is the only
      // signal that this queue is not draining.
      isPaused: vi.fn().mockResolvedValue(true),
    } as unknown as Queue;

    const counts = await collectQueueCounts([queueA, queueB]);

    expect(counts).toEqual({
      "book-detected": {
        waiting: 1,
        active: 2,
        completed: 3,
        failed: 4,
        delayed: 5,
        isPaused: false,
      },
      "book-organize": {
        waiting: 0,
        active: 1,
        completed: 0,
        failed: 0,
        delayed: 0,
        isPaused: true,
      },
    });
  });

  it("sorts failed jobs newest first", async () => {
    const queue = {
      name: "book-fetch-metadata",
      getJobs: vi.fn().mockResolvedValue([
        {
          id: "older",
          name: "metadata",
          data: {},
          failedReason: "Older",
          finishedOn: 10,
          processedOn: null,
          timestamp: 1,
          attemptsMade: 1,
          opts: { attempts: 3 },
        },
        {
          id: "newer",
          name: "metadata",
          data: {},
          failedReason: "Newer",
          finishedOn: 20,
          processedOn: null,
          timestamp: 2,
          attemptsMade: 2,
          opts: { attempts: 3 },
        },
      ]),
    } as unknown as Queue;

    const failed = await collectFailedJobs([queue]);

    expect(failed.total).toBe(2);
    expect(failed.jobs.map((job) => job.id)).toEqual(["newer", "older"]);
  });

  it("prefers the registered queue registry when available", () => {
    const registeredQueue = { name: "db-maintenance" } as Queue;
    vi.mocked(getAllQueues).mockReturnValue(new Map([[registeredQueue.name, registeredQueue]]));

    expect(getRegisteredQueues()).toEqual([registeredQueue]);
    expect(getQueues).not.toHaveBeenCalled();
  });

  it("resets only known BullMQ queue key prefixes", async () => {
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["0", ["bull:book-detected:1", "bull:book-detected:meta"]])
      .mockResolvedValue(["0", []]);
    const del = vi.fn().mockResolvedValue(2);
    const connect = vi.fn().mockResolvedValue(undefined);
    const quit = vi.fn().mockResolvedValue("OK");
    const disconnect = vi.fn();

    vi.mocked(Redis).mockImplementation(function () {
      return { scan, del, connect, quit, disconnect } as never;
    });

    const result = await resetBullMqState("redis://localhost:6379");

    expect(result.deletedKeys).toBe(2);
    expect(result.patterns).toContain("bull:book-detected:*");
    expect(result.patterns).toContain("bull:db-maintenance:*");
    expect(del).toHaveBeenCalledWith("bull:book-detected:1", "bull:book-detected:meta");
    expect(connect).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
