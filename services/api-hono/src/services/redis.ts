import Redis, { type RedisOptions } from "ioredis";
import { getLogger } from "../lib/logger.js";
import { getEnv, parseRedisUrl } from "../env.js";

const logger = getLogger("redis");

let _shared: Redis | null = null;
let _request: Redis | null = null;

/**
 * Redis client for request-path key/value work. BullMQ requires unlimited
 * retries, but HTTP requests need commands to reject promptly so middleware
 * can fail open, fall back, or fail authentication closed.
 */
export function createRequestRedis(options: RedisOptions): Redis {
  const redis = new Redis({
    ...options,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    commandTimeout: 250,
    lazyConnect: true,
  });
  redis.on("error", (err: Error) => logger.warn(`Request Redis error: ${err.message}`));
  return redis;
}

export function getRequestRedis(): Redis {
  if (!_request) {
    _request = createRequestRedis(parseRedisUrl(getEnv().REDIS_URL));
  }
  return _request;
}

/**
 * Returns the shared ioredis instance used by BullMQ queues, the event bus
 * publisher, and the key-value store. Creating one instance instead of letting
 * each BullMQ Queue/Worker open its own connection dramatically reduces the
 * total number of Redis connections.
 *
 * Workers and the subscriber client still get their own connections because
 * the Redis protocol requires dedicated connections for blocking reads and
 * SUBSCRIBE mode.
 */
export function getSharedRedis(): Redis {
  if (!_shared) {
    const opts = parseRedisUrl(getEnv().REDIS_URL);
    _shared = new Redis({
      ...opts,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    _shared.on("error", (err: Error) => logger.warn(`Shared Redis error: ${err.message}`));
    void _shared.connect();
  }
  return _shared;
}

/**
 * Check whether the shared Redis instance is connected and responsive.
 */
export async function isRedisHealthy(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    if (!_request) {
      return { ok: false, latencyMs: 0, error: "Redis not initialized" };
    }
    await _request.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Gracefully close the shared connection. Called during server shutdown.
 */
export async function closeSharedRedis(): Promise<void> {
  const connections = [_shared, _request].filter((conn): conn is Redis => conn !== null);
  _shared = null;
  _request = null;
  for (const conn of connections) {
    try {
      await conn.quit();
    } catch {
      conn.disconnect();
    }
  }
  if (connections.length > 0) logger.info("Redis connections closed");
}
