import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import type { RateLimitTier } from "../services/rate-limit.js";
import { getCredentialRateLimitKey, getIpRateLimitKey } from "../shared/request-ip.js";

export function resolveRateLimitTiers(path: string, method: string): RateLimitTier[] {
  // Liveness must remain observable when Redis is unavailable. The handler
  // reports Redis as degraded using the bounded request-path connection.
  if (path === "/api/health") return [];

  // Better Auth rate-limits its own prefix, with per-endpoint windows far
  // tighter than anything here (three requests per ten seconds on sign-in,
  // change-password and change-email). Applying a second limiter on top would
  // stack two independent budgets and produce 429s neither one explains, so
  // this middleware stands aside for the whole prefix.
  if (path.startsWith("/api/auth/")) return [];

  const tiers: RateLimitTier[] = [];

  // Endpoints that mint a credential. Slow and expensive, and worth capping
  // separately from ordinary traffic:
  //   /api/setup is PUBLIC — it has to be, nobody can authenticate on a fresh
  //   install — and hashes a password before it can 409.
  //   /api/app-passwords needs a session, so it is far less exposed, but a
  //   loop through it still costs a hash apiece.
  const isCredentialCreation =
    method === "POST" && (path === "/api/setup" || path === "/api/app-passwords");

  if (isCredentialCreation) {
    tiers.push("keyCreation");
  }

  // Brute-force tier: endpoints that take a credential as input and say whether
  // it was right. Better Auth covers its own; KoSync is the one left, because
  // KOReader speaks its own protocol on its own prefix.
  const isCredentialCheck = path === "/kosync/users/auth" || isCredentialCreation;

  if (isCredentialCheck) {
    tiers.push("auth");
  } else {
    // Default closed: static files, unknown paths and any future namespace are
    // bounded too. Explicitly exempt only health and Better Auth above.
    tiers.push("general");
  }

  return tiers;
}

export const rateLimitMiddleware = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    const env = c.get("env");

    // The E2E harness deliberately opts out; NODE_ENV alone changes no rate
    // limit behavior. Development uses the in-memory store.
    if (env.E2E_TEST === "1") {
      return next();
    }

    const ip = getIpRateLimitKey(c.get("clientIp"));
    const path = c.req.path;
    const method = c.req.method;
    const storage = c.get("redisStorage");

    let rateLimitInfo: { limit: number; remaining: number; resetIn: number } | null = null;

    const applyTier = async (tier: RateLimitTier, identity = ip) => {
      const info = await enforceRateLimit(storage, identity, tier, env);
      if (!rateLimitInfo || info.remaining < rateLimitInfo.remaining) {
        rateLimitInfo = info;
      }
    };

    for (const tier of resolveRateLimitTiers(path, method)) {
      await applyTier(tier);
    }

    // Brute-force budgets also follow the credential being guessed, so rotating
    // source addresses cannot reset attempts against one account.
    let credentialIdentifier: string | undefined;
    if (path === "/kosync/users/auth") {
      credentialIdentifier = c.req.header("x-auth-user");
    } else if (path === "/api/auth/sign-in/email" && method === "POST") {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => null)) as { email?: unknown } | null;
      if (typeof body?.email === "string") credentialIdentifier = body.email;
    }
    if (credentialIdentifier) {
      await applyTier("auth", getCredentialRateLimitKey(credentialIdentifier));
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
