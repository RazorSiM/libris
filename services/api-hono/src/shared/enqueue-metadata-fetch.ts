import { HTTPException } from "hono/http-exception";
import type { JobsOptions } from "bullmq";
import type { BookFetchMetadataPayload } from "../types/index.js";
import { IN_FLIGHT_STATES } from "./enqueue-book-organize.js";

const MAX_USER_METADATA_JOBS = 10;

interface QueueJob {
  data?: BookFetchMetadataPayload;
  getState?(): Promise<string>;
  remove?(): Promise<void>;
}

interface MetadataQueue {
  add(name: string, data: BookFetchMetadataPayload, opts?: JobsOptions): Promise<unknown>;
  getJob?(id: string): Promise<QueueJob | undefined>;
  getJobs?(states: string[]): Promise<QueueJob[]>;
}

export function metadataFetchJobId(bookId: string): string {
  return `fetch-metadata-${bookId}`;
}

/**
 * Enqueue a manual metadata refetch/rescan on behalf of a user.
 *
 * Mirrors `enqueueUserReorganize`: a deterministic job id collapses repeat
 * clicks on the same book into one job (returns false when one is already in
 * flight), and a per-user cap stops one caller fanning out across a whole
 * library — the endpoint had neither, so a loop could queue unbounded work
 * against the metadata providers.
 */
export async function enqueueUserMetadataFetch(
  queue: MetadataQueue,
  payload: { bookId: string; searchQuery: string; skipStatusChange?: boolean },
  userId: string,
): Promise<boolean> {
  const jobId = metadataFetchJobId(payload.bookId);
  const existing = await queue.getJob?.(jobId);
  if (existing) {
    const state = await existing.getState?.();
    if (!state || IN_FLIGHT_STATES.includes(state)) return false;
    await existing.remove?.();
  }

  if (queue.getJobs) {
    const jobs = await queue.getJobs(IN_FLIGHT_STATES);
    const userJobs = jobs.filter(({ data }) => data?.requestedBy === userId).length;
    if (userJobs >= MAX_USER_METADATA_JOBS) {
      throw new HTTPException(429, { message: "Too many metadata jobs already in progress" });
    }
  }

  await queue.add("fetch-metadata", { ...payload, requestedBy: userId }, { jobId });
  return true;
}
