import type Redis from "ioredis";

/**
 * Minimal key-value store interface that replaces unstorage.
 *
 * In production the backing store is the shared ioredis instance (zero extra
 * connections). In dev/test an in-memory Map is used instead.
 */
export interface KVStore {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  increment(key: string, ttl: number): Promise<number>;
  getKeys(base?: string): Promise<string[]>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Redis-backed implementation
// ---------------------------------------------------------------------------

export function createRedisKVStore(redis: Redis, prefix: string): KVStore {
  const pfx = prefix ? `${prefix}:` : "";

  function fullKey(key: string): string {
    return `${pfx}${key}`;
  }

  return {
    async getItem(key: string): Promise<unknown> {
      const raw = await redis.get(fullKey(key));
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },

    async setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      if (opts?.ttl) {
        await redis.set(fullKey(key), serialized, "EX", opts.ttl);
      } else {
        await redis.set(fullKey(key), serialized);
      }
    },

    async increment(key: string, ttl: number): Promise<number> {
      const value = await redis.eval(
        "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return value",
        1,
        fullKey(key),
        String(ttl),
      );
      return Number(value);
    },

    async getKeys(base?: string): Promise<string[]> {
      const pattern = base ? `${pfx}${base}*` : `${pfx}*`;
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        for (const k of batch) {
          // Strip the prefix so callers see the same keys as before
          keys.push(k.startsWith(pfx) ? k.slice(pfx.length) : k);
        }
      } while (cursor !== "0");
      return keys;
    },

    async removeItem(key: string): Promise<void> {
      await redis.del(fullKey(key));
    },

    async clear(): Promise<void> {
      const pattern = `${pfx}*`;
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;
        if (batch.length > 0) {
          await redis.del(...batch);
        }
      } while (cursor !== "0");
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation (dev / test)
// ---------------------------------------------------------------------------

export function createMemoryKVStore(): KVStore {
  const store = new Map<string, { value: unknown; expiresAt?: number }>();

  function isExpired(entry: { expiresAt?: number }): boolean {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  }

  return {
    async getItem(key: string): Promise<unknown> {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    async setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
      const expiresAt = opts?.ttl ? Date.now() + opts.ttl * 1000 : undefined;
      store.set(key, { value, expiresAt });
    },

    async increment(key: string, ttl: number): Promise<number> {
      const entry = store.get(key);
      const now = Date.now();
      if (!entry || isExpired(entry)) {
        store.set(key, { value: 1, expiresAt: now + ttl * 1000 });
        return 1;
      }
      const next = Number(entry.value) + 1;
      entry.value = next;
      return next;
    },

    async getKeys(base?: string): Promise<string[]> {
      const results: string[] = [];
      for (const [key, entry] of store) {
        if (isExpired(entry)) {
          store.delete(key);
          continue;
        }
        if (!base || key.startsWith(base)) {
          results.push(key);
        }
      }
      return results;
    },

    async removeItem(key: string): Promise<void> {
      store.delete(key);
    },

    async clear(): Promise<void> {
      store.clear();
    },
  };
}
