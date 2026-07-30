import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { compare } from "bcryptjs";
import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { getLogger } from "../lib/logger.js";
import { apiKeys, serviceCredentials } from "#db";
import type { Db } from "#db";
import type { AppVariables } from "../context.js";
import { resolvePolicy } from "../shared/route-policy.js";
import { KEY_PREFIX_LENGTH, DUMMY_HASH } from "../shared/auth.js";
import { readSession } from "../shared/session.js";
import { requireKosyncAuth } from "../shared/kosync-auth.js";
import { getRequestIp } from "../shared/request-ip.js";

// ── Auth result cache ─────────────────────────────────────────────
// Avoids running bcrypt on every authenticated request.
// Keys are SHA-256 digests of the raw credential — never the credential itself.
//
// IMPORTANT: Any route that creates, deletes, or modifies API key privileges
// (e.g. isAdmin, scopes) MUST call clearAuthCaches() after the DB write.
// Otherwise stale authorization data will be served for up to CACHE_TTL_MS.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 500;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= CACHE_MAX) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const apiKeyCache = new TtlCache<{ id: string; label: string | null; isAdmin: boolean }>();
const opdsCache = new TtlCache<{ apiKeyId: string }>();

/**
 * Clear all in-memory auth caches (apiKeyCache + opdsCache).
 *
 * Call this after any operation that changes key validity or privileges:
 * - Deleting an API key
 * - Updating key privileges (isAdmin, scopes, etc.)
 * - Rotating OPDS credentials
 *
 * Also used by test cleanup to prevent cross-test leakage.
 */
export function clearAuthCaches(): void {
  apiKeyCache.clear();
  opdsCache.clear();
}

const logger = getLogger("auth");

const OPDS_REALM = "libris-opds";

function opds401(message: string): HTTPException {
  return new HTTPException(401, {
    message,
    res: new Response(JSON.stringify({ error: message }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Basic realm="${OPDS_REALM}"`,
      },
    }),
  });
}

/**
 * Extract the raw API key from the Authorization header.
 * Supports:
 *   - Bearer <key>
 *   - Basic base64(user:pass)
 */
function extractKey(header: string): string | null {
  const [scheme, credentials] = header.split(" ", 2);
  if (!scheme || !credentials) return null;

  if (scheme.toLowerCase() === "bearer") {
    return credentials;
  }

  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(credentials, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    return decoded.substring(0, colon);
  }

  return null;
}

/** Extract username and password from Basic auth header */
function extractBasicCredentials(header: string): { username: string; password: string } | null {
  const [scheme, credentials] = header.split(" ", 2);
  if (!scheme || !credentials || scheme.toLowerCase() !== "basic") return null;

  const decoded = Buffer.from(credentials, "base64").toString("utf-8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { username: decoded.substring(0, colon), password: decoded.substring(colon + 1) };
}

/**
 * Authenticate an OPDS request using Basic auth against service_credentials.
 * Requires OPDS credentials to be configured in the database.
 * Returns the apiKeyId for the matched credential so the caller can set user identity.
 */
async function requireOpdsAuth(authHeader: string | undefined, db: Db): Promise<string> {
  if (!authHeader) {
    throw opds401("Authentication required");
  }

  const basic = extractBasicCredentials(authHeader);
  if (!basic) {
    throw opds401("Invalid credentials");
  }

  const cacheKey = sha256(`${basic.username}:${basic.password}`);
  const cached = opdsCache.get(cacheKey);
  if (cached) return cached.apiKeyId;

  const [cred] = await db
    .select()
    .from(serviceCredentials)
    .where(
      and(eq(serviceCredentials.service, "opds"), eq(serviceCredentials.username, basic.username)),
    )
    .limit(1);

  if (!cred) {
    // Run bcrypt against dummy hash to normalize timing even when no credential found
    await compare(basic.password, DUMMY_HASH);
    throw opds401("Invalid credentials");
  }

  const valid = await compare(basic.password, cred.passwordHash);
  if (!valid) {
    throw opds401("Invalid credentials");
  }

  if (!cred.apiKeyId) {
    throw opds401("OPDS credentials not linked to a user. Reconfigure in Settings.");
  }

  opdsCache.set(cacheKey, { apiKeyId: cred.apiKeyId });
  return cred.apiKeyId;
}

export const authMiddleware = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const path = c.req.path;
  const policy = resolvePolicy(path);
  const db = c.get("db");
  const env = c.get("env");

  // Default to false so c.get('isAdmin') is always a boolean,
  // even for policies (skip/public/optional) that may not authenticate.
  c.set("isAdmin", false);

  const validateApiKey = async (required: boolean, explicitKey?: string): Promise<void> => {
    let key: string | null = explicitKey ?? null;

    // Try Bearer/Basic header first
    if (!key) {
      const authHeader = c.req.header("authorization");
      if (authHeader) {
        key = extractKey(authHeader);
      }
    }

    // Fall back to session cookie if no header
    if (!key) {
      const session = await readSession(c);
      if (session?.apiKey) {
        key = session.apiKey;
      }
    }

    if (!key) {
      if (required) throw new HTTPException(401, { message: "Authentication required" });
      return;
    }

    const cacheKey = sha256(key);
    const cached = apiKeyCache.get(cacheKey);
    if (cached) {
      c.set("apiKeyId", cached.id);
      c.set("apiKeyLabel", cached.label ?? undefined);
      c.set("isAdmin", cached.isAdmin);
      return;
    }

    const prefix = key.substring(0, KEY_PREFIX_LENGTH);
    const candidates = await db
      .select()
      .from(apiKeys)
      .where(or(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.keyPrefix, "")));

    let matchedKey: (typeof candidates)[number] | null = null;
    for (const row of candidates) {
      const matches = await compare(key, row.keyHash);
      if (matches) {
        matchedKey = row;
        break;
      }
    }

    if (!matchedKey) {
      logger.warn(`Auth failure from ${getRequestIp(c)}`);
      if (required) throw new HTTPException(401, { message: "Invalid API key" });
      return;
    }

    apiKeyCache.set(cacheKey, {
      id: matchedKey.id,
      label: matchedKey.label ?? null,
      isAdmin: matchedKey.isAdmin,
    });

    // Update lastUsedAt in background (don't block the request)
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, matchedKey.id))
      .catch((err) =>
        logger.withMetadata({ error: String(err) }).warn("Failed to update lastUsedAt"),
      );

    c.set("apiKeyId", matchedKey.id);
    c.set("apiKeyLabel", matchedKey.label);
    c.set("isAdmin", matchedKey.isAdmin);
  };

  switch (policy) {
    case "skip":
      if (
        path.startsWith("/__test/") &&
        !(env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.E2E_TEST === "1")
      ) {
        throw new HTTPException(404, { message: "Not found" });
      }
      break;

    case "public":
      break;

    case "optional":
      await validateApiKey(false);
      break;

    case "kosync": {
      if (path === "/kosync/users/auth" || path === "/kosync/users/create") break;
      const kosyncApiKeyId = await requireKosyncAuth(
        {
          username: c.req.header("x-auth-user"),
          password: c.req.header("x-auth-key"),
        },
        db,
      );
      c.set("apiKeyId", kosyncApiKeyId);
      c.set("isAdmin", false);
      break;
    }

    case "opds": {
      const opdsApiKeyId = await requireOpdsAuth(c.req.header("authorization"), db);
      c.set("apiKeyId", opdsApiKeyId);
      c.set("isAdmin", false);
      break;
    }

    case "api-key":
      await validateApiKey(true);
      break;

    case "admin":
      await validateApiKey(true);
      if (!c.get("isAdmin")) {
        throw new HTTPException(403, { message: "Admin access required" });
      }
      break;
  }

  await next();
});
