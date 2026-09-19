import { describe, expect, it, vi } from "vite-plus/test";
import type { Job, JobType } from "bullmq";
import {
  MAX_JOB_WINDOW,
  collectBoardJobs,
  isPageBeyondWindow,
  isWindowTruncated,
  planJobWindow,
  sortJobWindow,
} from "./jobs-window.js";
import type { JobBoard } from "./jobs-window.js";

function fakeJob(id: string, timestamp: number): Job {
  return { id, timestamp, name: "job", data: {} } as unknown as Job;
}

describe("planJobWindow", () => {
  it("gives a single selected board the whole materialization budget", () => {
    const plan = planJobWindow(1, 20, 1);
    expect(plan.perBoardLimit).toBe(MAX_JOB_WINDOW);
    expect(plan.depth).toBe(20);
    expect(plan.start).toBe(0);
  });

  it("splits the budget across boards: all queues x all statuses is 35 boards", () => {
    const plan = planJobWindow(1, 20, 35);
    expect(plan.perBoardLimit).toBe(Math.floor(MAX_JOB_WINDOW / 35));
  });

  it("caps each board's fetch at the requested page's depth", () => {
    const plan = planJobWindow(3, 20, 1);
    expect(plan.perBoardLimit).toBe(MAX_JOB_WINDOW);
    expect(plan.depth).toBe(60);
    expect(plan.start).toBe(40);
  });

  it("never plans a zero-depth fetch", () => {
    expect(planJobWindow(1, 1, 0).perBoardLimit).toBe(MAX_JOB_WINDOW);
    expect(planJobWindow(1, 1, 0).depth).toBe(1);
  });
});

describe("isPageBeyondWindow", () => {
  it("is false on the last page wholly inside the window", () => {
    // Page 500 at 20/page starts at 9,980, one page short of 10,000.
    expect(isPageBeyondWindow(planJobWindow(500, 20, 1))).toBe(false);
  });

  it("is true once the page starts at or past the window", () => {
    expect(isPageBeyondWindow(planJobWindow(501, 20, 1))).toBe(true);
    expect(isPageBeyondWindow(planJobWindow(502, 20, 1))).toBe(true);
  });
});

describe("isWindowTruncated", () => {
  it("flags any board holding more matching jobs than the window fetches", () => {
    expect(isWindowTruncated([2_001, 0], 2_000)).toBe(true);
    expect(isWindowTruncated([0, 2_000], 2_000)).toBe(false);
    expect(isWindowTruncated([], 2_000)).toBe(false);
  });
});

describe("sortJobWindow", () => {
  it("orders newest first across queues", () => {
    const sorted = sortJobWindow([
      { id: "old", queueName: "a", timestamp: 1 },
      { id: "new", queueName: "b", timestamp: 3 },
      { id: "mid", queueName: "c", timestamp: 2 },
    ]);
    expect(sorted.map((job) => job.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks timestamp ties by queue name then job id, deterministically", () => {
    const tied = [
      { id: "2", queueName: "b", timestamp: 5 },
      { id: "1", queueName: "b", timestamp: 5 },
      { id: "9", queueName: "a", timestamp: 5 },
    ];
    expect(sortJobWindow([...tied]).map((job) => job.id)).toEqual(["9", "1", "2"]);
    expect(sortJobWindow([...tied]).map((job) => job.id)).toEqual(["9", "1", "2"]);
  });
});

describe("collectBoardJobs", () => {
  it("fetches each board separately, bounded by depth, and attributes its status", async () => {
    const calls: [string, number, number][] = [];
    const queue: JobBoard = {
      name: "queue",
      getJobs: vi.fn(async (statuses: JobType[] | JobType, start: number, end: number) => {
        const status = Array.isArray(statuses) ? statuses[0]! : statuses;
        calls.push([status, start, end]);
        return [fakeJob(`${status}-1`, 1)];
      }),
    };

    const jobs = await collectBoardJobs(
      [queue],
      ["completed", "waiting"],
      7,
      (job, queueName, status) => ({
        id: job.id!,
        queueName,
        timestamp: job.timestamp,
        status,
      }),
    );

    expect(calls).toEqual([
      ["completed", 0, 6],
      ["waiting", 0, 6],
    ]);
    expect(jobs).toEqual([
      { id: "completed-1", queueName: "queue", timestamp: 1, status: "completed" },
      { id: "waiting-1", queueName: "queue", timestamp: 1, status: "waiting" },
    ]);
  });

  it("skips jobs without an id", async () => {
    const queue: JobBoard = {
      name: "q",
      getJobs: async () => [{ name: "no-id", timestamp: 1 } as unknown as Job],
    };
    const jobs = await collectBoardJobs([queue], ["failed"], 10, (job, queueName, status) => ({
      id: job.id!,
      queueName,
      timestamp: job.timestamp,
      status,
    }));
    expect(jobs).toEqual([]);
  });
});
