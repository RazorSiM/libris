import { describe, expect, it, vi } from "vite-plus/test";
import { enqueueUserReorganize } from "./enqueue-book-organize.js";

describe("enqueueUserReorganize", () => {
  it("collapses concurrent requests for one book onto one BullMQ job ID", async () => {
    const jobs = new Map<string, { data: { bookId: string; requestedBy: string } }>();
    const queue = {
      getJob: vi.fn(async (id: string) => jobs.get(id)),
      getJobs: vi.fn(async () => [...jobs.values()]),
      add: vi.fn(async (_name, data, options) => {
        jobs.set(options.jobId, { data });
        return {};
      }),
    };

    await Promise.all(
      Array.from({ length: 150 }, () => enqueueUserReorganize(queue, "book-1", "user-1")),
    );

    expect(jobs).toHaveLength(1);
    expect(new Set(queue.add.mock.calls.map((call) => call[2].jobId))).toEqual(
      new Set(["organize-book-1"]),
    );
  });

  it("rejects a user who already has ten in-flight organize jobs", async () => {
    const queue = {
      getJob: vi.fn(async () => undefined),
      getJobs: vi.fn(async () =>
        Array.from({ length: 10 }, (_, index) => ({
          data: { bookId: `book-${index}`, requestedBy: "user-1" },
        })),
      ),
      add: vi.fn(),
    };

    await expect(enqueueUserReorganize(queue, "book-11", "user-1")).rejects.toMatchObject({
      status: 429,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
