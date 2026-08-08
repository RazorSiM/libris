/**
 * The atomic counters, against a Redis that can actually lose an update.
 *
 * Two increments back this codebase's rate limiting: `createRedisKVStore`
 * (services/kv-store.ts, used by middleware/rate-limit.ts) and
 * `createRedisSecondaryStorage` (used by Better Auth's own limiter). Both trade
 * an INCR + a conditional EXPIRE for a single EVAL, precisely so two requests
 * arriving together cannot both read the same count.
 *
 * Neither had a behavioural test before this file. The only concurrency
 * test in the tree fired 1000 calls at `createMemoryKVStore`, whose increment is
 * a synchronous Map read-modify-write in one JS turn — atomic by construction,
 * incapable of losing an update whatever the production path does. The other
 * "coverage" string-matched the Lua source against /INCR/, which proves the
 * script's text and nothing about its behaviour.
 *
 * What is asserted here is the property itself: N concurrent increments hand
 * back 1..N, each exactly once. Rewriting either increment as GET/SET/EXPIRE
 * turns that red.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type Redis from "ioredis";
import type { Env } from "../src/env.js";
import { createRedisKVStore } from "../src/services/kv-store.js";
import { createRedisSecondaryStorage } from "../src/services/auth-secondary-storage.js";
import { checkRateLimit } from "../src/services/rate-limit.js";
import {
  announceSkip,
  connectTestRedis,
  isRedisReachable,
  SERVICES_ARE_REQUIRED,
  TEST_REDIS_URL,
} from "./backing-services.js";

const reachable = await isRedisReachable();

if (!reachable) {
  const why =
    `Redis at ${TEST_REDIS_URL} is unreachable. The atomicity of the rate-limit counters ` +
    `CANNOT be checked against createMemoryKVStore — its increment is a synchronous Map ` +
    `write and can never lose an update, so a memory-backed version of these tests would ` +
    `pass with the production path replaced by GET/SET. Start one with ` +
    `\`docker compose -f docker-compose.test.yml up -d --wait redis\`, or point ` +
    `LIBRIS_TEST_REDIS_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("redis-increment.test.ts", why);
}

/** How many callers arrive at once. Large enough that a lost update is certain. */
const BURST = 250;

describe.skipIf(!reachable)("atomic increments against real Redis", () => {
  let redis: Redis;
  /** Unique per run so parallel worktrees sharing one server cannot collide. */
  let prefix: string;
  let keySeq = 0;

  beforeAll(async () => {
    redis = await connectTestRedis();
    prefix = `libris-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  /** A key no other test has touched, so counts start from zero. */
  const freshKey = () => `k${(keySeq += 1)}`;

  describe("createRedisKVStore.increment", () => {
    it("hands every one of a concurrent burst a distinct number", async () => {
      const store = createRedisKVStore(redis, prefix);
      const key = freshKey();

      const results = await Promise.all(
        Array.from({ length: BURST }, () => store.increment(key, 60)),
      );

      // A GET/SET pair loses updates here: several callers read the same value
      // and hand back the same number, so the sorted list has duplicates and
      // stops short of BURST.
      const values = results.map(({ value }) => value).sort((a, b) => a - b);
      expect(values).toEqual(Array.from({ length: BURST }, (_, i) => i + 1));
      expect(Number(await redis.get(`${prefix}:${key}`))).toBe(BURST);
    });

    it("puts a ttl on the counter the moment it is created", async () => {
      const store = createRedisKVStore(redis, prefix);
      const key = freshKey();

      const { ttl } = await store.increment(key, 90);

      // A counter with no expiry would rate-limit its owner forever.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(90);
      expect(await redis.ttl(`${prefix}:${key}`)).toBeGreaterThan(0);
    });

    it("does not push the window out on later increments", async () => {
      const store = createRedisKVStore(redis, prefix);
      const key = freshKey();

      await store.increment(key, 600);
      // A second call with a much shorter window must not re-arm the expiry.
      // Unguarded EXPIRE would drop the remaining ttl from ~600 to 5, which is
      // a client hammering the endpoint into an early reset.
      const { ttl } = await store.increment(key, 5);

      expect(ttl).toBeGreaterThan(500);
      expect(await redis.ttl(`${prefix}:${key}`)).toBeGreaterThan(500);
    });
  });

  describe("createRedisSecondaryStorage.increment", () => {
    it("hands every one of a concurrent burst a distinct number", async () => {
      const storage = createRedisSecondaryStorage(redis, prefix);
      const key = freshKey();

      const results = await Promise.all(
        Array.from({ length: BURST }, () => Promise.resolve(storage.increment!(key, 60))),
      );

      expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: BURST }, (_, i) => i + 1));
    });

    it("does not push the window out on later increments", async () => {
      const storage = createRedisSecondaryStorage(redis, prefix);
      const key = freshKey();

      await storage.increment!(key, 600);
      await storage.increment!(key, 5);

      expect(await redis.ttl(`${prefix}:${key}`)).toBeGreaterThan(500);
    });

    it("consumes a single-use value with GETDEL, so it cannot be read twice", async () => {
      const storage = createRedisSecondaryStorage(redis, prefix);
      const key = freshKey();
      await storage.set(key, "one-shot");

      // Both readers arrive together; exactly one may win.
      const [a, b] = await Promise.all([
        Promise.resolve(storage.getAndDelete!(key)),
        Promise.resolve(storage.getAndDelete!(key)),
      ]);

      expect([a, b].filter((v) => v === "one-shot")).toHaveLength(1);
      expect(await storage.get(key)).toBeNull();
    });
  });

  describe("checkRateLimit over the production store", () => {
    const ENV = {
      NODE_ENV: "production",
      LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 10,
      LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 60,
      LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
      LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
      LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
      LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
    } as Env;

    it("admits exactly the configured limit when the whole burst arrives at once", async () => {
      // This is the claim the old memory-store test made and could not keep:
      // a credential-stuffing burst hitting one process must get exactly 30
      // attempts, not 30-per-lost-update.
      const store = createRedisKVStore(redis, prefix);
      const identity = freshKey();

      const results = await Promise.all(
        Array.from({ length: BURST }, () => checkRateLimit(store, identity, "auth", ENV)),
      );

      expect(results.filter(({ retryAfter }) => retryAfter === null)).toHaveLength(30);
      expect(results.filter(({ retryAfter }) => retryAfter !== null)).toHaveLength(BURST - 30);
    });

    it("reports a retryAfter inside the configured window once it refuses", async () => {
      const store = createRedisKVStore(redis, prefix);
      const identity = freshKey();
      const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 1 } as Env;

      expect((await checkRateLimit(store, identity, "auth", env)).retryAfter).toBeNull();
      const refused = await checkRateLimit(store, identity, "auth", env);

      expect(refused.retryAfter).toBeGreaterThan(0);
      expect(refused.retryAfter).toBeLessThanOrEqual(60);
      expect(refused.remaining).toBe(0);
    });
  });
});
