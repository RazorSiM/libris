import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../../context.js";
import { getQueues, getAllQueues } from "../../services/queue.js";
import {
  collectFailedJobs,
  collectQueueCounts,
  getRegisteredQueues,
} from "../../services/queue-diagnostics.js";
import type { Queue, Job } from "bullmq";

// ── Shared Schemas ──────────────────────────────────────────────

const JobDetailSchema = z.object({
  id: z.string(),
  queueName: z.string(),
  name: z.string(),
  data: z.record(z.string(), z.unknown()),
  status: z.string(),
  progress: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
  returnValue: z.unknown().optional(),
  failedReason: z.string().optional(),
  stacktrace: z.array(z.string()).optional(),
  attemptsMade: z.number().int(),
  maxAttempts: z.number().int(),
  timestamp: z.number(),
  processedOn: z.number().nullable(),
  finishedOn: z.number().nullable(),
  duration: z.number().nullable(),
});

// ── GET /status ──────────────────────────────────────────────────

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["jobs"],
  summary: "Job queue status",
  description: "Return job counts per queue (waiting, active, completed, failed, delayed, paused)",
  responses: {
    200: {
      description: "Queue status counts",
      content: {
        "application/json": {
          schema: z.object({
            queues: z.record(
              z.string(),
              z.object({
                waiting: z.number().int(),
                active: z.number().int(),
                completed: z.number().int(),
                failed: z.number().int(),
                delayed: z.number().int(),
                paused: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// ── GET /failed ──────────────────────────────────────────────────

const failedRoute = createRoute({
  method: "get",
  path: "/failed",
  tags: ["jobs"],
  summary: "List failed jobs",
  description:
    "Return failed jobs across all queues with job ID, queue name, error message, timestamps, and attempt count",
  responses: {
    200: {
      description: "List of failed jobs",
      content: {
        "application/json": {
          schema: z.object({
            jobs: z.array(
              z.object({
                id: z.string(),
                queueName: z.string(),
                name: z.string(),
                data: z.record(z.string(), z.unknown()),
                error: z.string(),
                failedAt: z.number(),
                attemptsMade: z.number().int(),
                maxAttempts: z.number().int(),
              }),
            ),
            total: z.number().int(),
          }),
        },
      },
    },
  },
});

// ── GET / (all-jobs browser) ─────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["jobs"],
  summary: "List jobs across all queues",
  description:
    "Browse recent jobs across all queues with filtering by queue name and status. " +
    "Supports pagination via page/pageSize query params.",
  request: {
    query: z.object({
      queue: z
        .string()
        .optional()
        .openapi({ description: "Filter by queue name (e.g. book-detected)" }),
      status: z
        .enum(["completed", "active", "waiting", "failed", "delayed", "paused"])
        .optional()
        .openapi({ description: "Filter by job status" }),
      page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
      pageSize: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .openapi({ description: "Items per page (max 100)" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of jobs",
      content: {
        "application/json": {
          schema: z.object({
            jobs: z.array(JobDetailSchema),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
            totalPages: z.number().int(),
          }),
        },
      },
    },
  },
});

// ── GET /{id} ────────────────────────────────────────────────────

const detailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["jobs"],
  summary: "Get job details",
  description:
    "Return full details for a specific job including stack trace, duration, progress, " +
    "timestamps, return value, and payload data. Requires queueName since BullMQ job IDs " +
    "are auto-incremented per queue and not unique across queues.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ description: "Job ID" }),
    }),
    query: z.object({
      queueName: z.string().min(1).openapi({
        description: "Queue this job belongs to (e.g. book-fetch-metadata)",
      }),
    }),
  },
  responses: {
    200: {
      description: "Job details",
      content: {
        "application/json": {
          schema: JobDetailSchema,
        },
      },
    },
    404: { description: "Queue or job not found" },
  },
});

// ── GET /{id}/logs ───────────────────────────────────────────────

const logsRoute = createRoute({
  method: "get",
  path: "/{id}/logs",
  tags: ["jobs"],
  summary: "Get job logs",
  description:
    "Return log lines stored via BullMQ job.log() for a specific job. " +
    "Logs are stored in Redis per job and provide a timeline of job execution. " +
    "Requires queueName since BullMQ job IDs are auto-incremented per queue and " +
    "not unique across queues.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ description: "Job ID" }),
    }),
    query: z.object({
      queueName: z.string().min(1).openapi({
        description: "Queue this job belongs to (e.g. book-fetch-metadata)",
      }),
    }),
  },
  responses: {
    200: {
      description: "Job logs",
      content: {
        "application/json": {
          schema: z.object({
            jobId: z.string(),
            logs: z.array(z.string()),
            count: z.number().int(),
          }),
        },
      },
    },
    404: { description: "Queue or job not found" },
  },
});

// ── POST /{id}/retry ─────────────────────────────────────────────

const retryRoute = createRoute({
  method: "post",
  path: "/{id}/retry",
  tags: ["jobs"],
  summary: "Retry a failed job",
  description:
    "Retry a specific failed job by ID. Requires queueName since BullMQ job IDs are " +
    "auto-incremented per queue and not unique across queues.",
  request: {
    params: z.object({
      id: z.string().min(1).openapi({ description: "Job ID to retry" }),
    }),
    query: z.object({
      queueName: z.string().min(1).openapi({
        description: "Queue this job belongs to (e.g. book-fetch-metadata)",
      }),
    }),
  },
  responses: {
    200: {
      description: "Job retried successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            jobId: z.string(),
            queueName: z.string(),
          }),
        },
      },
    },
    400: { description: "Job is not in failed state" },
    404: { description: "Queue or job not found" },
  },
});

// ── POST /queues/{name}/pause ────────────────────────────────────

const pauseQueueRoute = createRoute({
  method: "post",
  path: "/queues/{name}/pause",
  tags: ["jobs"],
  summary: "Pause a queue",
  description: "Pause a specific queue by name. New jobs will not be processed until resumed.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ description: "Queue name (e.g. book-detected)" }),
    }),
  },
  responses: {
    200: {
      description: "Queue paused",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), queue: z.string(), paused: z.boolean() }),
        },
      },
    },
    404: { description: "Queue not found" },
  },
});

// ── POST /queues/{name}/resume ───────────────────────────────────

const resumeQueueRoute = createRoute({
  method: "post",
  path: "/queues/{name}/resume",
  tags: ["jobs"],
  summary: "Resume a queue",
  description: "Resume a paused queue. Jobs will begin processing again.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ description: "Queue name" }),
    }),
  },
  responses: {
    200: {
      description: "Queue resumed",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), queue: z.string(), paused: z.boolean() }),
        },
      },
    },
    404: { description: "Queue not found" },
  },
});

// ── POST /queues/{name}/clean ────────────────────────────────────

const cleanQueueRoute = createRoute({
  method: "post",
  path: "/queues/{name}/clean",
  tags: ["jobs"],
  summary: "Clean failed jobs from a queue",
  description: "Remove all failed jobs from a specific queue.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ description: "Queue name" }),
    }),
  },
  responses: {
    200: {
      description: "Failed jobs cleaned",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), queue: z.string(), removed: z.number().int() }),
        },
      },
    },
    404: { description: "Queue not found" },
  },
});

// ── POST /queues/{name}/drain ────────────────────────────────────

const drainQueueRoute = createRoute({
  method: "post",
  path: "/queues/{name}/drain",
  tags: ["jobs"],
  summary: "Drain a queue",
  description: "Remove all waiting and delayed jobs from a queue. Active jobs are not affected.",
  request: {
    params: z.object({
      name: z.string().min(1).openapi({ description: "Queue name" }),
    }),
  },
  responses: {
    200: {
      description: "Queue drained",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), queue: z.string() }),
        },
      },
    },
    404: { description: "Queue not found" },
  },
});

// ── Helpers ──────────────────────────────────────────────────────

function serializeJob(job: Job, queueName: string) {
  const processedOn = job.processedOn ?? null;
  const finishedOn = job.finishedOn ?? null;
  const duration = processedOn !== null && finishedOn !== null ? finishedOn - processedOn : null;

  return {
    id: job.id!,
    queueName,
    name: job.name,
    data: job.data as Record<string, unknown>,
    status: "", // will be set by caller
    progress: (job.progress as number | Record<string, unknown>) ?? undefined,
    returnValue: job.returnvalue ?? undefined,
    failedReason: job.failedReason ?? undefined,
    stacktrace: job.stacktrace?.length ? job.stacktrace : undefined,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts?.attempts ?? 1,
    timestamp: job.timestamp,
    processedOn,
    finishedOn,
    duration,
  };
}

function findQueueByName(name: string): Queue | null {
  // Check all-queues registry first
  const allQueues = getAllQueues();
  if (allQueues.has(name)) {
    return allQueues.get(name)!;
  }
  // Fallback to pipeline queues
  const { close: _, ...queues } = getQueues();
  for (const queue of Object.values(queues) as Queue[]) {
    if (queue.name === name) return queue;
  }
  return null;
}

// ── Router ───────────────────────────────────────────────────────

export const jobsRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(statusRoute, async (c) => {
    const results = await collectQueueCounts(getRegisteredQueues());
    return c.json({ queues: results });
  })
  .openapi(failedRoute, async (c) => {
    const { jobs, total } = await collectFailedJobs(getRegisteredQueues());
    return c.json({ jobs, total });
  })
  .openapi(listRoute, async (c) => {
    const { queue: queueFilter, status, page, pageSize } = c.req.valid("query");

    // Determine which queues to query
    let queuesToQuery: Queue[];
    if (queueFilter) {
      const q = findQueueByName(queueFilter);
      if (!q) {
        return c.json({ jobs: [], total: 0, page, pageSize, totalPages: 0 });
      }
      queuesToQuery = [q];
    } else {
      queuesToQuery = getRegisteredQueues();
    }

    // Determine statuses to query
    type JobStatus = "completed" | "active" | "waiting" | "failed" | "delayed" | "paused";
    const statuses: JobStatus[] = status
      ? [status]
      : ["completed", "active", "waiting", "failed", "delayed"];

    // Collect jobs from all matching queues
    type JobWithStatus = ReturnType<typeof serializeJob> & { status: string };
    const allJobs: JobWithStatus[] = [];

    await Promise.all(
      queuesToQuery.map(async (queue) => {
        const jobs: Job[] = await queue.getJobs(statuses, 0, 199);
        for (const job of jobs) {
          if (!job.id) continue;
          const state = await job.getState();
          if (status && state !== status) continue;
          const serialized = serializeJob(job, queue.name);
          allJobs.push({ ...serialized, status: state });
        }
      }),
    );

    // Sort by timestamp descending (most recent first)
    allJobs.sort((a, b) => b.timestamp - a.timestamp);

    // Paginate
    const total = allJobs.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const paginatedJobs = allJobs.slice(start, start + pageSize);

    return c.json({ jobs: paginatedJobs, total, page, pageSize, totalPages });
  })
  .openapi(detailRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { queueName } = c.req.valid("query");

    const queue = findQueueByName(queueName);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${queueName}" not found` });
    }

    const job: Job | undefined = await queue.getJob(id);
    if (!job) {
      throw new HTTPException(404, {
        message: `Job ${id} not found in queue "${queueName}"`,
      });
    }

    const state = await job.getState();
    const serialized = serializeJob(job, queue.name);
    return c.json({ ...serialized, status: state });
  })
  .openapi(logsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { queueName } = c.req.valid("query");

    const queue = findQueueByName(queueName);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${queueName}" not found` });
    }

    const job: Job | undefined = await queue.getJob(id);
    if (!job) {
      throw new HTTPException(404, {
        message: `Job ${id} not found in queue "${queueName}"`,
      });
    }

    const { logs, count } = await queue.getJobLogs(id);
    return c.json({ jobId: id, logs, count });
  })
  .openapi(retryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { queueName } = c.req.valid("query");

    const queue = findQueueByName(queueName);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${queueName}" not found` });
    }

    const job: Job | undefined = await queue.getJob(id);
    if (!job) {
      throw new HTTPException(404, {
        message: `Job ${id} not found in queue "${queueName}"`,
      });
    }

    const state = await job.getState();
    if (state !== "failed") {
      throw new HTTPException(400, {
        message: `Job ${id} is not in failed state (current: ${state})`,
      });
    }
    await job.retry(state);
    return c.json({
      success: true,
      jobId: id,
      queueName: queue.name,
    });
  })
  .openapi(pauseQueueRoute, async (c) => {
    const { name } = c.req.valid("param");
    const queue = findQueueByName(name);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${name}" not found` });
    }
    await queue.pause();
    return c.json({ success: true, queue: name, paused: true });
  })
  .openapi(resumeQueueRoute, async (c) => {
    const { name } = c.req.valid("param");
    const queue = findQueueByName(name);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${name}" not found` });
    }
    await queue.resume();
    return c.json({ success: true, queue: name, paused: false });
  })
  .openapi(cleanQueueRoute, async (c) => {
    const { name } = c.req.valid("param");
    const queue = findQueueByName(name);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${name}" not found` });
    }
    const removed = await queue.clean(0, 1000, "failed");
    return c.json({ success: true, queue: name, removed: removed.length });
  })
  .openapi(drainQueueRoute, async (c) => {
    const { name } = c.req.valid("param");
    const queue = findQueueByName(name);
    if (!queue) {
      throw new HTTPException(404, { message: `Queue "${name}" not found` });
    }
    await queue.drain();
    return c.json({ success: true, queue: name });
  });
