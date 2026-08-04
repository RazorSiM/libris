import { HTTPException } from "hono/http-exception";
import type { JobsOptions } from "bullmq";
import type { BookOrganizePayload } from "../types/index.js";

const MAX_USER_ORGANIZE_JOBS = 10;
const IN_FLIGHT_STATES = ["active", "waiting", "delayed", "prioritized", "waiting-children"];

interface QueueJob {
  data?: BookOrganizePayload;
  getState?(): Promise<string>;
  remove?(): Promise<void>;
}

interface OrganizeQueue {
  add(name: string, data: BookOrganizePayload, opts?: JobsOptions): Promise<unknown>;
  getJob?(id: string): Promise<QueueJob | undefined>;
  getJobs?(states: string[]): Promise<QueueJob[]>;
}

export function organizeJobId(bookId: string, forceRedownloadCover = false): string {
  return `organize-${bookId}${forceRedownloadCover ? "-cover" : ""}`;
}

export async function enqueueBookOrganize(
  queue: OrganizeQueue,
  payload: BookOrganizePayload,
): Promise<void> {
  const jobId = organizeJobId(payload.bookId, payload.forceRedownloadCover);
  const existing = await queue.getJob?.(jobId);
  if (existing) {
    const state = await existing.getState?.();
    if (!state || IN_FLIGHT_STATES.includes(state)) return;
    await existing.remove?.();
  }
  await queue.add("organize", payload, { jobId });
}

export async function enqueueUserReorganize(
  queue: OrganizeQueue,
  bookId: string,
  userId: string,
): Promise<void> {
  const jobId = organizeJobId(bookId);
  const existing = await queue.getJob?.(jobId);
  if (existing) {
    const state = await existing.getState?.();
    if (!state || IN_FLIGHT_STATES.includes(state)) return;
    await existing.remove?.();
  }

  if (queue.getJobs) {
    const jobs = await queue.getJobs(IN_FLIGHT_STATES);
    const userJobs = jobs.filter(({ data }) => data?.requestedBy === userId).length;
    if (userJobs >= MAX_USER_ORGANIZE_JOBS) {
      throw new HTTPException(429, { message: "Too many organize jobs already in progress" });
    }
  }

  await enqueueBookOrganize(queue, { bookId, requestedBy: userId });
}
