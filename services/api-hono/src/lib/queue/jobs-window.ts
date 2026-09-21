/**
 * Windowing rules for the admin jobs browser.
 *
 * BullMQ has no cross-queue, cross-status index ordered by job creation time:
 * `getJobs` ranges each requested status board independently and concatenates
 * the results in that board's native order (waiting/active insertion order,
 * completed/failed by finish time, delayed by scheduled time). Honouring
 * "newest first" across boards therefore requires reading a prefix of every
 * board, and the only open question is how large that prefix may get.
 *
 * These helpers make that budget explicit and testable, and give the route a
 * deterministic ordering to merge the fetched window with.
 */
import type { Job, JobType } from "bullmq";

/** Global number of jobs one list request may materialize across all boards. */
export const MAX_JOB_WINDOW = 10_000;

export interface JobWindowPlan {
  /** Matching jobs fetched from each (queue, status) board. */
  perBoardLimit: number;
  /** Jobs fetched from each board for the requested page. */
  depth: number;
  /** Offset of the requested page inside the merged window. */
  start: number;
}

/**
 * Split the global materialization budget across the selected boards and cap
 * the per-board fetch at the requested page's depth. A single queue/status
 * selection gets the whole budget; more selections trade depth for breadth.
 */
export function planJobWindow(page: number, pageSize: number, boards: number): JobWindowPlan {
  const perBoardLimit = Math.max(1, Math.floor(MAX_JOB_WINDOW / Math.max(1, boards)));
  return {
    perBoardLimit,
    depth: Math.min(page * pageSize, perBoardLimit),
    start: (page - 1) * pageSize,
  };
}

/** Whether the requested page lies past everything the window can hold. */
export function isPageBeyondWindow(plan: JobWindowPlan): boolean {
  return plan.start >= plan.perBoardLimit;
}

/**
 * Whether any board holds more matching jobs than the window fetches. True
 * means `total` counts jobs that cannot be paged to, so the response is
 * honest about the truncation instead of failing silently.
 */
export function isWindowTruncated(boardCounts: readonly number[], perBoardLimit: number): boolean {
  return boardCounts.some((count) => count > perBoardLimit);
}

export interface WindowedJob {
  id: string;
  queueName: string;
  timestamp: number;
}

/**
 * The slice of BullMQ's `Queue` this module needs. Declared structurally so
 * tests can drive the real class or a fake interchangeably. The status
 * parameter mirrors BullMQ's own `JobType[] | JobType` spelling exactly —
 * anything narrower is not assignable to the real class.
 */
export interface JobBoard {
  name: string;
  getJobs(statuses: JobType[] | JobType, start: number, end: number): Promise<Job[]>;
}

/**
 * Read each (queue, status) board in its native order, at most `depth` jobs
 * per board. Jobs are attributed to the board they came from — a board is
 * authoritative for its own status — so no per-job `getState()` round trip is
 * needed and a state change mid-request cannot drop a fetched job.
 */
export async function collectBoardJobs<T extends WindowedJob>(
  queues: readonly JobBoard[],
  statuses: readonly JobType[],
  depth: number,
  serialize: (job: Job, queueName: string, status: string) => T,
): Promise<T[]> {
  const jobs: T[] = [];
  await Promise.all(
    queues.map(async (queue) => {
      for (const status of statuses) {
        const board = await queue.getJobs([status], 0, depth - 1);
        for (const job of board) {
          if (!job.id) continue;
          jobs.push(serialize(job, queue.name, status));
        }
      }
    }),
  );
  return jobs;
}

/**
 * Order the merged window newest-first, with a deterministic fallback so two
 * requests (or two pages) cannot disagree about tied jobs: creation time, then
 * queue name, then job id.
 */
export function sortJobWindow<T extends WindowedJob>(jobs: T[]): T[] {
  return jobs.sort(
    (a, b) =>
      b.timestamp - a.timestamp ||
      a.queueName.localeCompare(b.queueName) ||
      a.id.localeCompare(b.id),
  );
}
