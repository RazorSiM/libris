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
 *
 * The connection is opened eagerly (libris-59m.14). `lazyConnect` on its own
 * leaves the client in status "wait" until the first command, and ioredis'
 * `sendCommand` forces `writable = false` while `this.stream` is undefined — so
 * with `enableOfflineQueue: false` the very first command after boot was
 * rejected outright with "Stream isn't writeable and enableOfflineQueue options
 * is false", regardless of whether Redis was actually up. That single guaranteed
 * rejection landed on the first authenticated request after every restart.
 *
 * `enableOfflineQueue: false` and the 250 ms `commandTimeout` stay: once the
 * connection exists, request-path commands must fail fast rather than queue
 * behind a reconnect. Callers treat Redis as a cache and degrade (see
 * auth-secondary-storage.ts and services/rate-limit.ts), so the process must
 * still start when Redis is unreachable — hence the caught connect.
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
  // Attach the handler first: an unhandled connect rejection here would take
  // the process down at boot for a dependency the app can run without.
  void redis.connect().catch((err: unknown) => {
    logger.warn(
      `Request Redis initial connect failed, retrying in background: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
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
