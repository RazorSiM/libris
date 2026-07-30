import Redis from "ioredis";
import { getLogger } from "../lib/logger.js";
import { getEnv, parseRedisUrl } from "../env.js";

const logger = getLogger("redis");

let _shared: Redis | null = null;

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
    if (!_shared) {
      return { ok: false, latencyMs: 0, error: "Redis not initialized" };
    }
    await _shared.ping();
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
  if (!_shared) return;
  const conn = _shared;
  _shared = null;
  try {
    await conn.quit();
  } catch {
    conn.disconnect();
  }
  logger.info("Shared Redis connection closed");
}
