import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import type { RateLimitTier } from "../services/rate-limit.js";
import { getCredentialRateLimitKey, getIpRateLimitKey } from "../shared/request-ip.js";

export function resolveRateLimitTiers(path: string, method: string): RateLimitTier[] {
  // /api/health takes the general tier like everything else.
  //
  // It used to be exempt, justified as "liveness must remain observable when
  // Redis is unavailable" — but the general tier already provides exactly that:
  // services/rate-limit.ts catches a store failure, logs "Rate limit check
  // failed, allowing request" and allows the request for every tier that is not
  // auth/keyCreation. The exemption bought nothing and removed the only bound
  // on an unauthenticated endpoint that costs a "SELECT 1" round-trip and a
  // Redis PING per call, and that access-log.ts also skips — so a flood of it
  // saturated the connection pool leaving no trace. 600/min per source is three
  // orders of magnitude above any orchestrator probe interval.

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
    // Default closed: health, static files, unknown paths and any future
    // namespace are bounded too. Only Better Auth's own prefix is exempt.
    tiers.push("general");
  }

  return tiers;
}

/**
 * Ceiling on a body this middleware is willing to parse.
 *
 * The only fields it reads are a username and an email, so a few kilobytes is
 * already generous. bodyLimitMiddleware runs first (app.ts) and caps every body
 * at 1 MB, so this is defence in depth: if the two are ever reordered, the
 * limiter still refuses to buffer something large.
 *
 * A caller that pads its body past this loses its per-credential bucket and
 * falls back to the per-IP tiers, which is the safe direction — refusing the
 * request outright would turn a rate-limit detail into a new way to reject
 * legitimate traffic.
 */
const MAX_CREDENTIAL_BODY_BYTES = 8192;

async function readCredentialBody(c: {
  req: { header: (name: string) => string | undefined; raw: Request };
}): Promise<Record<string, unknown> | null> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > MAX_CREDENTIAL_BODY_BYTES) return null;

  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
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
      // Two shapes for one credential check. GET carries the username in
      // x-auth-user; POST carries it in the JSON body — and takes the PLAINTEXT
      // password, so it is the better oracle of the two and needs the budget
      // more. Without reading the body, POST attempts accumulated only per
      // source address and an attacker rotating addresses never spent one.
      credentialIdentifier = c.req.header("x-auth-user");
      if (!credentialIdentifier && method === "POST") {
        const body = await readCredentialBody(c);
        if (typeof body?.username === "string") credentialIdentifier = body.username;
      }
    } else if (path === "/api/auth/sign-in/email" && method === "POST") {
      const body = await readCredentialBody(c);
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
