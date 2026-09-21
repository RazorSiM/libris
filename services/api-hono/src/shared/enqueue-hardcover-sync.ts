import type { JobsOptions } from "bullmq";
import { IN_FLIGHT_STATES } from "./enqueue-book-organize.js";

interface QueueJob {
  getState?(): Promise<string>;
  remove?(): Promise<void>;
}

interface HardcoverSyncQueue {
  add(name: string, data: { manual: true; userId: string }, opts?: JobsOptions): Promise<unknown>;
  getJob?(id: string): Promise<QueueJob | undefined>;
}

export function hardcoverSyncJobId(userId: string): string {
  return `hardcover-sync-${userId}`;
}

/**
 * Enqueue a manual Hardcover sync for one user.
 *
 * The route used to add a fresh `manual-sync` job on every request. A
 * deterministic per-user job id makes repeat clicks idempotent: returns false
 * when a sync is already queued or running, true when a new job was added.
 */
export async function enqueueHardcoverSync(
  queue: HardcoverSyncQueue,
  userId: string,
): Promise<boolean> {
  const jobId = hardcoverSyncJobId(userId);
  const existing = await queue.getJob?.(jobId);
  if (existing) {
    const state = await existing.getState?.();
    if (!state || IN_FLIGHT_STATES.includes(state)) return false;
    await existing.remove?.();
  }
  await queue.add("manual-sync", { manual: true, userId }, { jobId });
  return true;
}
