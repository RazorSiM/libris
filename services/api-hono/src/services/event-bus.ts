import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { books, type Db } from "#db";
import { getLogger } from "../lib/logger.js";
import { getEnv, parseRedisUrl } from "../env.js";
import { getSharedRedis } from "./redis.js";

const CHANNEL = "books:events";
const logger = getLogger("event-bus");

/** Detect test mode: check NODE_ENV and VITEST env var */
const isTestMode = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export interface ServerEvent {
  type: string;
  bookId?: string;
  payload?: Record<string, unknown>;
  timestamp: string;
  /** Internal routing key. Never serialize this to a WebSocket client. */
  userId?: string;
}

/**
 * Internal EventEmitter bridges Redis pub/sub messages to local listeners.
 * Each SSE connection subscribes to this emitter — only one Redis subscriber
 * connection is needed regardless of how many clients are connected.
 */
const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(200);

/** The pub side reuses the shared ioredis instance (no extra connection). */
let pubClient: Redis | null = null;

/**
 * The sub side MUST be a dedicated connection — Redis protocol requires that
 * a connection in SUBSCRIBE mode cannot issue other commands.
 */
let subClient: Redis | null = null;
let initialized = false;

function initRedis(): void {
  if (initialized || isTestMode) return;

  const redisUrl = getEnv().REDIS_URL;
  if (!redisUrl) {
    logger.warn("No REDIS_URL configured — event bus disabled");
    return;
  }

  // Reuse the shared connection for publishing
  pubClient = getSharedRedis();

  // Dedicated connection for the subscriber
  const redisOpts = parseRedisUrl(redisUrl);
  subClient = new Redis({
    ...redisOpts,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableReadyCheck: false,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 10_000);
      logger.info(`Event bus reconnecting (attempt ${times}, delay ${delay}ms)`);
      return delay;
    },
    reconnectOnError(err: Error) {
      const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
      return targetErrors.some((e) => err.message.includes(e));
    },
  });

  subClient.on("error", (err: Error) => logger.warn(`Event bus sub error: ${err.message}`));

  void subClient.connect().then(async () => {
    await subClient!.subscribe(CHANNEL);
    subClient!.on("message", (_ch: string, msg: string) => {
      try {
        localEmitter.emit("event", JSON.parse(msg));
      } catch {
        // ignore malformed messages
      }
    });
    logger.info("Event bus subscriber connected");
  });

  initialized = true;
}

/**
 * Publish a server event. Workers call this after completing jobs.
 * In test mode, events are emitted locally (no Redis needed).
 */
export async function publishEvent(event: Omit<ServerEvent, "timestamp">): Promise<void> {
  const full: ServerEvent = { ...event, timestamp: new Date().toISOString() };

  if (isTestMode) {
    localEmitter.emit("event", full);
    return;
  }

  initRedis();
  if (pubClient) {
    try {
      await pubClient.publish(CHANNEL, JSON.stringify(full));
    } catch (err) {
      logger.withMetadata({ error: String(err) }).warn("Failed to publish event");
    }
  }
}

/**
 * Publish a book event to its owner. Events without an owner are intentionally
 * visible only to administrators, rather than leaking pipeline details to every
 * authenticated subscriber.
 */
export async function publishBookEvent(
  db: Db,
  event: Omit<ServerEvent, "timestamp" | "userId"> & { bookId: string },
): Promise<void> {
  const [book] = await db
    .select({ userId: books.createdBy })
    .from(books)
    .where(eq(books.id, event.bookId))
    .limit(1);

  await publishEvent({ ...event, userId: book?.userId });
}

/**
 * Subscribe to server events. Returns an unsubscribe function.
 * Each subscriber is filtered at the event bus before its WebSocket sends.
 */
export function onServerEvent(
  callback: (event: ServerEvent) => void,
  subscriber: { userId: string; isAdmin: boolean },
): () => void {
  initRedis();
  const scopedCallback = (event: ServerEvent) => {
    if (!subscriber.isAdmin && event.userId !== subscriber.userId) return;
    callback(event);
  };
  localEmitter.on("event", scopedCallback);
  return () => {
    localEmitter.off("event", scopedCallback);
  };
}

/**
 * Check whether the event bus subscriber connection is healthy.
 */
export function isEventBusHealthy(): { ok: boolean; error?: string } {
  if (isTestMode) return { ok: true };
  initRedis();
  if (!initialized) return { ok: false, error: "Event bus not initialized" };
  if (!subClient) return { ok: false, error: "Subscriber not created" };
  const status = subClient.status;
  if (status === "ready" || status === "connecting" || status === "connect") return { ok: true };
  return { ok: false, error: `Subscriber status: ${status}` };
}

/**
 * Close the event bus connections. Called during server shutdown.
 * NOTE: pubClient is the shared instance — do NOT close it here;
 * it is closed by closeSharedRedis().
 */
export async function closeEventBus(): Promise<void> {
  localEmitter.removeAllListeners();
  if (subClient) {
    try {
      await subClient.unsubscribe(CHANNEL);
      await subClient.quit();
    } catch {
      subClient.disconnect();
    }
    subClient = null;
  }
  pubClient = null;
  initialized = false;
  logger.info("Event bus closed");
}
