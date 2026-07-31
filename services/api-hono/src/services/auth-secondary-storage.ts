import type Redis from "ioredis";
import type { BetterAuthOptions } from "better-auth/types";

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

export function createRedisSecondaryStorage(redis: Redis, prefix = "ba"): SecondaryStorage {
  const pfx = prefix ? `${prefix}:` : "";
  const fullKey = (key: string) => `${pfx}${key}`;

  return {
    async get(key) {
      return await redis.get(fullKey(key));
    },

    async getAndDelete(key) {
      // Redis >= 6.2. The deployed image is redis:7 (docker-compose.dev.yml
      // and the production compose both pin the 7 line).
      return await redis.getdel(fullKey(key));
    },

    async increment(key, ttl) {
      const value = await redis.eval(INCREMENT_SCRIPT, 1, fullKey(key), String(ttl));
      return Number(value);
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
