import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import type { RateLimitTier } from "../services/rate-limit.js";
import { getRequestIp } from "../shared/request-ip.js";

export function resolveRateLimitTiers(path: string, method: string): RateLimitTier[] {
  const tiers: RateLimitTier[] = [];

  if (
    (path === "/api/auth/setup" && method === "POST") ||
    (path === "/api/auth/keys" && method === "POST")
  ) {
    tiers.push("keyCreation");
  }

  // Brute-force tier: only endpoints that take a credential as input.
  // Read/list/delete/session endpoints don't probe credentials and belong in `general`.
  const isCredentialInput =
    (path === "/api/auth/login" && method === "POST") ||
    (path === "/api/auth/setup" && method === "POST") ||
    (path === "/api/auth/keys" && method === "POST") ||
    path === "/kosync/users/auth";

  if (isCredentialInput) {
    tiers.push("auth");
  } else if (path.startsWith("/api/") || path.startsWith("/kosync/") || path.startsWith("/opds")) {
    tiers.push("general");
  }

  return tiers;
}

export const rateLimitMiddleware = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    const env = c.get("env");

    // Skip rate limiting during tests and development
    if (env.NODE_ENV === "test" || env.NODE_ENV === "development" || env.E2E_TEST === "1") {
      return next();
    }

    const ip = getRequestIp(c);
    const path = c.req.path;
    const method = c.req.method;
    const storage = c.get("redisStorage");

    let rateLimitInfo: { limit: number; remaining: number; resetIn: number } | null = null;

    const applyTier = async (tier: RateLimitTier) => {
      const info = await enforceRateLimit(storage, ip, tier, env);
      if (!rateLimitInfo || info.remaining < rateLimitInfo.remaining) {
        rateLimitInfo = info;
      }
    };

    for (const tier of resolveRateLimitTiers(path, method)) {
      await applyTier(tier);
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const info = rateLimitInfo as { limit: number; remaining: number; resetIn: number } | null;
    if (info) {
      const resetAt = Math.floor(Date.now() / 1000) + info.resetIn;
      c.header("X-RateLimit-Limit", String(info.limit));
      c.header("X-RateLimit-Remaining", String(info.remaining));
      c.header("X-RateLimit-Reset", String(resetAt));
    }

    await next();
  },
);
