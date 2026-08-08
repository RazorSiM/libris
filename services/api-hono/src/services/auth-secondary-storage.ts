import type Redis from "ioredis";
import type { BetterAuthOptions } from "better-auth/types";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("auth-storage");

// better-auth does not re-export SecondaryStorage, and the declaring package
// (@better-auth/core) is only a transitive dependency — importing from it
// directly would mean carrying a second version to keep in lockstep. Deriving
// the type from the option we actually pass tracks upstream for free.
type SecondaryStorage = NonNullable<BetterAuthOptions["secondaryStorage"]>;

/**
 * Better Auth `secondaryStorage` implementations.
 *
 * Deliberately separate from the general-purpose `KVStore` in kv-store.ts:
 * Better Auth's contract includes two *atomic* operations that KVStore cannot
 * express, and both matter for correctness rather than convenience.
 *
 * - `increment` backs secondary-storage rate limiting. A read-modify-write
 *   would let concurrent requests each read the same counter and undercount,
 *   which is exactly the case a rate limiter exists to catch.
 * - `getAndDelete` backs single-use credentials. A read-then-delete race would
 *   let the same token be consumed twice.
 *
 * Values are stored and returned as raw strings. Better Auth serialises its own
 * payloads, so parsing here (as KVStore does) would hand it back an object
 * where it expects a string.
 */

// TTL is applied only when the counter is created. Later increments must not
// extend it, otherwise a client that keeps hammering the endpoint keeps pushing
// the window out and never resets. INCR+EXPIRE as two round-trips would leave a
// TTL-less key behind if the process died in between, so it goes in one script.
const INCREMENT_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value
`;

/**
 * Counters that survive a Redis outage without failing open.
 *
 * Better Auth's `onRequestRateLimit` calls `secondaryStorage.increment` from
 * `onRequest` and does not catch — a rejecting client turned every
 * `/api/auth/*` call into a 500, including `get-session`. Process-local
 * counting is weaker than shared counting (each process keeps its own budget)
 * but it is still counting, which is the property a brute-force limiter needs.
 * Returning a low value instead would hand an attacker an unlimited budget the
 * moment Redis blinked.
 *
 * Module-level so the fallback survives a reconnect: a flapping Redis must not
 * hand out a fresh window on every blip.
 */
const fallbackCounters = new Map<string, { value: number; expiresAt: number }>();

function incrementInMemory(key: string, ttl: number): number {
  const now = Date.now();
  const entry = fallbackCounters.get(key);
  if (!entry || entry.expiresAt <= now) {
    // Only a fresh counter sets the window, matching the Lua script.
    fallbackCounters.set(key, { value: 1, expiresAt: now + ttl * 1000 });
    if (fallbackCounters.size > 10_000) {
      for (const [k, v] of fallbackCounters) if (v.expiresAt <= now) fallbackCounters.delete(k);
    }
    return 1;
  }
  entry.value += 1;
  return entry.value;
}

/** Exposed for tests; production code never needs to reset the fallback. */
export function resetSecondaryStorageFallback(): void {
  fallbackCounters.clear();
}

/**
 * Redis is a cache in front of durable state, and this is where that shows.
 *
 * Sessions are written to Postgres as well (`session.storeSessionInDatabase`),
 * and better-auth's `findSession` falls through to the `sessions` row whenever
 * secondary storage answers null. A MISS therefore degrades gracefully; a THROW
 * aborts before the fallback is ever reached, and `middleware/auth.ts` turns it
 * into a 401. A 400 ms Redis pause (BGSAVE, AOF rewrite, failover) used to sign
 * every logged-in user out even though every session row was intact.
 *
 * So: reads degrade to a miss, writes stay loud.
 *
 * - `get` / `getAndDelete` return null on error. For `getAndDelete` that is also
 *   the safe direction: a single-use token that cannot be read is treated as
 *   absent and refused, never as consumed-and-valid.
 * - `set` and `delete` still reject. A dropped `delete` is a revocation that
 *   silently did not happen, which must surface as an error the caller can
 *   retry rather than as a success.
 * - `increment` falls back to the process-local counter above.
 */
export function createRedisSecondaryStorage(redis: Redis, prefix = "ba"): SecondaryStorage {
  const pfx = prefix ? `${prefix}:` : "";
  const fullKey = (key: string) => `${pfx}${key}`;

  const degradeToMiss = (operation: string, key: string, err: unknown): null => {
    logger
      .withMetadata({ operation, key: fullKey(key) })
      .warn(
        `Redis ${operation} failed, treating as a miss so the database fallback runs: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    return null;
  };

  return {
    async get(key) {
      try {
        return await redis.get(fullKey(key));
      } catch (err) {
        return degradeToMiss("get", key, err);
      }
    },

    async getAndDelete(key) {
      try {
        // Redis >= 6.2. The deployed image is redis:7 (docker-compose.dev.yml
        // and the production compose both pin the 7 line).
        return await redis.getdel(fullKey(key));
      } catch (err) {
        return degradeToMiss("getAndDelete", key, err);
      }
    },

    async increment(key, ttl) {
      try {
        const value = await redis.eval(INCREMENT_SCRIPT, 1, fullKey(key), String(ttl));
        return Number(value);
      } catch (err) {
        logger
          .withMetadata({ key: fullKey(key) })
          .warn(
            `Redis increment failed, counting in process memory instead: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        return incrementInMemory(fullKey(key), ttl);
      }
    },

    async set(key, value, ttl) {
      if (ttl) {
        await redis.set(fullKey(key), value, "EX", ttl);
      } else {
        await redis.set(fullKey(key), value);
      }
    },

    async delete(key) {
      await redis.del(fullKey(key));
    },
  };
}

/** How Better Auth indexes a user's live sessions in secondary storage. */
const ACTIVE_SESSIONS_KEY = (userId: string) => `active-sessions-${userId}`;

interface ActiveSessionEntry {
  token: string;
  expiresAt: number;
}

/**
 * Drop every secondary-storage entry belonging to a user's sessions.
 *
 * ⚠︎ RE-VERIFY ON EVERY BETTER AUTH BUMP. This mirrors the secondary-storage
 * half of `internalAdapter.deleteUserSessions` (dist/db/internal-adapter.mjs),
 * including the `active-sessions-<userId>` index key and the
 * `{ token, expiresAt }` entry shape written by `createSession`. Verified
 * against better-auth 1.6.25.
 *
 * Needed because `internalAdapter.deleteUser` does NOT do this. It
 * issues three statements — delete session ROWS, delete account rows, delete the
 * user row — and never touches secondary storage. `findSession` reads secondary
 * storage FIRST and returns whatever it finds without re-checking that the user
 * still exists, so a session left behind there keeps resolving, with the deleted
 * account's cached user object attached, until its TTL lapses.
 *
 * Today `/admin/remove-user` masks that by calling `deleteUserSessions`
 * immediately before `deleteUser` — but that is one caller's ordering, not a
 * property of deletion. Better Auth's own `/delete-user` calls the two in the
 * opposite order, and an upstream refactor that drops the extra call turns a
 * removed account into a live one.
 *
 * Idempotent by construction: when the index key is already gone there is
 * nothing to do, which is the normal case on the remove-user path.
 */
export async function clearUserSessions(
  secondaryStorage: SecondaryStorage,
  userId: string,
): Promise<void> {
  const raw = await secondaryStorage.get(ACTIVE_SESSIONS_KEY(userId));
  if (!raw) return;

  let entries: ActiveSessionEntry[] = [];
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) entries = parsed as ActiveSessionEntry[];
  } catch {
    // A corrupt index is still worth clearing: leaving it would leave the
    // tokens it names unreachable and undeletable.
  }

  for (const entry of entries) {
    if (typeof entry?.token === "string") await secondaryStorage.delete(entry.token);
  }
  await secondaryStorage.delete(ACTIVE_SESSIONS_KEY(userId));
}

/**
 * In-memory equivalent for dev and test, mirroring how bootstrap falls back to
 * createMemoryKVStore(). Single-process only — it makes no attempt to be
 * correct across workers, which is fine because dev and test run one process.
 */
export function createMemorySecondaryStorage(): SecondaryStorage {
  const store = new Map<string, { value: string; expiresAt?: number }>();

  function read(key: string): string | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async get(key) {
      return read(key);
    },

    async getAndDelete(key) {
      const value = read(key);
      store.delete(key);
      return value;
    },

    async increment(key, ttl) {
      const current = read(key);
      if (current === null) {
        // Fresh counter: this is the only point at which the TTL is set.
        store.set(key, { value: "1", expiresAt: Date.now() + ttl * 1000 });
        return 1;
      }
      const next = Number(current) + 1;
      // Preserve the original expiry rather than restarting the window.
      store.set(key, { value: String(next), expiresAt: store.get(key)?.expiresAt });
      return next;
    },

    async set(key, value, ttl) {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : undefined });
    },

    async delete(key) {
      store.delete(key);
    },
  };
}
