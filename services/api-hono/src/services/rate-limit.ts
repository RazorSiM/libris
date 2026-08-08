import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.js";
import type { KVStore } from "./kv-store.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("rate-limit");

interface RateLimitConfig {
  /** Max requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

export type RateLimitTier = "keyCreation" | "auth" | "general";

export function getTiers(env: Env): Record<RateLimitTier, RateLimitConfig> {
  return {
    keyCreation: {
      limit: env.LIBRIS_RATELIMIT_KEY_CREATION_LIMIT,
      windowSeconds: env.LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS,
    },
    auth: {
      limit: env.LIBRIS_RATELIMIT_AUTH_LIMIT,
      windowSeconds: env.LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS,
    },
    general: {
      limit: env.LIBRIS_RATELIMIT_GENERAL_LIMIT,
      windowSeconds: env.LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS,
    },
  };
}

// ── In-memory fallback for auth tiers when Redis is down ─────────────

const memoryStore = new Map<string, { count: number; expiresAt: number }>();

function checkMemoryFallback(
  ip: string,
  tier: RateLimitTier,
  config: RateLimitConfig,
): { retryAfter: number | null; remaining: number; limit: number; resetIn: number } {
  const { limit, windowSeconds } = config;
  const key = `${tier}:${ip}`;
  const now = Date.now();

  const entry = memoryStore.get(key);
  if (entry && entry.expiresAt > now) {
    entry.count++;
    if (entry.count > limit) {
      const resetIn = Math.ceil((entry.expiresAt - now) / 1000);
      return { retryAfter: resetIn, remaining: 0, limit, resetIn };
    }
    return {
      retryAfter: null,
      remaining: Math.max(0, limit - entry.count),
      limit,
      resetIn: Math.ceil((entry.expiresAt - now) / 1000),
    };
  }

  // New window or expired entry
  memoryStore.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });

  // Lazy cleanup: prune expired entries occasionally
  if (memoryStore.size > 1000) {
    for (const [k, v] of memoryStore) {
      if (v.expiresAt <= now) memoryStore.delete(k);
    }
  }

  return { retryAfter: null, remaining: limit - 1, limit, resetIn: windowSeconds };
}

/**
 * Check rate limit for an IP and tier.
 * Returns limit info including retryAfter (seconds until window resets if rate-limited, or null if allowed),
 * remaining requests, the limit, and seconds until the window resets.
 */
export async function checkRateLimit(
  storage: KVStore,
  ip: string,
  tier: RateLimitTier,
  env: Env,
): Promise<{ retryAfter: number | null; remaining: number; limit: number; resetIn: number }> {
  const config = getTiers(env)[tier];

  const { limit, windowSeconds } = config;
  // Anchor the window to the caller's first request instead of wall-clock
  // boundaries. A new bucket is therefore never available one millisecond
  // after exhausting the previous one.
  const key = `ratelimit:${tier}:${ip}`;

  try {
    const { value: current, ttl: resetIn } = await storage.increment(key, windowSeconds);

    if (current > limit) {
      return { retryAfter: resetIn, remaining: 0, limit, resetIn };
    }

    const remaining = Math.max(0, limit - current);
    return { retryAfter: null, remaining, limit, resetIn };
  } catch (err) {
    // Redis unavailable — use in-memory fallback for auth-critical tiers
    if (tier === "auth" || tier === "keyCreation") {
      logger
        .withMetadata({ error: String(err) })
        .warn(`Redis unavailable, using in-memory fallback for ${tier}`);
      return checkMemoryFallback(ip, tier, config);
    }
    // Fail open for general tier
    logger.withMetadata({ error: String(err) }).warn("Rate limit check failed, allowing request");
    return { retryAfter: null, remaining: limit - 1, limit, resetIn: windowSeconds };
  }
}

/**
 * Enforce rate limit for a request — throws HTTPException 429 if exceeded.
 * Returns limit info on success.
 */
export async function enforceRateLimit(
  storage: KVStore,
  ip: string,
  tier: RateLimitTier,
  env: Env,
): Promise<{ limit: number; remaining: number; resetIn: number }> {
  const { retryAfter, remaining, limit, resetIn } = await checkRateLimit(storage, ip, tier, env);
  if (retryAfter !== null) {
    const resetAt = Math.floor(Date.now() / 1000) + retryAfter;
    throw new HTTPException(429, {
      message: "Too many requests",
      res: new Response("Too many requests", {
        status: 429,
        headers: {
          "retry-after": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(resetAt),
        },
      }),
    });
  }
  return { limit, remaining, resetIn };
}
