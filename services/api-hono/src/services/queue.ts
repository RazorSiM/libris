import { Queue, type ConnectionOptions } from "bullmq";
import type {
  BookDetectedPayload,
  BookFetchMetadataPayload,
  BookOrganizePayload,
  BookParseFilePayload,
} from "../types/index.js";
import {
  QUEUE_BOOK_DETECTED,
  QUEUE_BOOK_FETCH_METADATA,
  QUEUE_BOOK_ORGANIZE,
  QUEUE_BOOK_PARSE_FILE,
} from "../lib/queue/constants.js";
import { getSharedRedis } from "./redis.js";

function createQueues(connection: ConnectionOptions) {
  const pipelineDefaults = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 1000 },
    removeOnComplete: { count: 1000, age: 7 * 24 * 3600 },
    removeOnFail: { count: 1000 },
  };

  const bookDetected = new Queue<BookDetectedPayload>(QUEUE_BOOK_DETECTED, {
    connection,
    defaultJobOptions: pipelineDefaults,
  });

  const bookParseFile = new Queue<BookParseFilePayload>(QUEUE_BOOK_PARSE_FILE, {
    connection,
    defaultJobOptions: pipelineDefaults,
  });

  const bookFetchMetadata = new Queue<BookFetchMetadataPayload>(QUEUE_BOOK_FETCH_METADATA, {
    connection,
    defaultJobOptions: pipelineDefaults,
  });

  const bookOrganize = new Queue<BookOrganizePayload>(QUEUE_BOOK_ORGANIZE, {
    connection,
    defaultJobOptions: pipelineDefaults,
  });

  const close = async () => {
    await Promise.all([
      bookDetected.close(),
      bookParseFile.close(),
      bookFetchMetadata.close(),
      bookOrganize.close(),
    ]);
  };

  return { bookDetected, bookParseFile, bookFetchMetadata, bookOrganize, close };
}

type Queues = ReturnType<typeof createQueues>;

let _queues: Queues | null = null;

export function getQueues(): Queues {
  if (!_queues) {
    // Cast needed: project ioredis version may differ from BullMQ's bundled version
    _queues = createQueues(getSharedRedis() as unknown as ConnectionOptions);
  }
  return _queues;
}

/** @internal Test-only: inject mock queues */
export function __setTestQueues(queues: Queues) {
  _queues = queues;
}

export async function closeQueues(): Promise<void> {
  if (!_queues) return;
  const q = _queues;
  _queues = null;
  await q.close();
}

// ── All-queues registry (includes scheduler queues from bootstrap) ──

const _allQueues = new Map<string, Queue>();

/**
 * Register a queue in the global all-queues registry.
 * Called from bootstrap.ts for every queue (pipeline + scheduler).
 */
export function registerQueue(queue: Queue): void {
  _allQueues.set(queue.name, queue);
}

/**
 * Return all registered queues as a name→Queue map.
 * Includes pipeline queues from getQueues() plus any scheduler queues.
 */
export function getAllQueues(): Map<string, Queue> {
  // Ensure pipeline queues are always included
  if (_queues) {
    const { close: _, ...pipelineQueues } = _queues;
    for (const q of Object.values(pipelineQueues)) {
      const queue = q as Queue;
      if (!_allQueues.has(queue.name)) {
        _allQueues.set(queue.name, queue);
      }
    }
  }
  return _allQueues;
}
