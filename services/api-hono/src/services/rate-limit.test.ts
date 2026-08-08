import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "../env.js";
import { createMemoryKVStore, type KVStore } from "./kv-store.js";
import { checkRateLimit } from "./rate-limit.js";
import { getCredentialRateLimitKey } from "../shared/request-ip.js";

const ENV = {
  NODE_ENV: "production",
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 10,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
} as Env;

describe("checkRateLimit", () => {
  afterEach(() => vi.useRealTimers());

  it("admits exactly the configured limit and refuses the rest", async () => {
    // Renamed from "under concurrency" (libris-59m.31), which it never tested:
    // createMemoryKVStore's increment is a synchronous Map read-modify-write in
    // a single JS turn, so it cannot lose an update however many callers there
    // are, and the production path (createRedisKVStore) was not involved. What
    // this DOES pin, and is worth keeping, is the boundary — the 30th call is
    // admitted and the 31st is not. The atomicity claim moved to
    // tests/redis-increment.test.ts, against the store production uses.
    const storage = createMemoryKVStore();
    const results = await Promise.all(
      Array.from({ length: 1_000 }, () => checkRateLimit(storage, "concurrent", "auth", ENV)),
    );

    expect(results.filter((result) => result.retryAfter === null)).toHaveLength(30);
    expect(results.filter((result) => result.retryAfter !== null)).toHaveLength(970);
  });

  it("does not grant a second burst at a wall-clock boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:59.900Z"));
    const storage = createMemoryKVStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 2 } as Env;

    expect((await checkRateLimit(storage, "boundary", "auth", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, "boundary", "auth", env)).retryAfter).toBeNull();
    vi.advanceTimersByTime(200);

    expect((await checkRateLimit(storage, "boundary", "auth", env)).retryAfter).toBeGreaterThan(0);
  });

  it("shares a credential budget across source addresses", async () => {
    const storage = createMemoryKVStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 2 } as Env;
    const identity = getCredentialRateLimitKey("reader@example.com");

    // The IP budget is separate; this identity follows the account being guessed.
    expect((await checkRateLimit(storage, identity, "auth", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, identity, "auth", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, identity, "auth", env)).retryAfter).toBeGreaterThan(0);
  });
});

/**
 * What happens when the store is down (libris-59m.31).
 *
 * `checkMemoryFallback` is what guards sign-in while Redis is unreachable, and
 * it had no tests at all — including the part that matters most, which is that
 * the auth tiers fail CLOSED onto a local limiter while the general tier fails
 * OPEN. Getting that backwards either lets a Redis outage become an unlimited
 * credential-stuffing window, or lets it take the whole library offline.
 */
describe("checkRateLimit when the store is unavailable", () => {
  /** Down the way Redis is down: every increment rejects. */
  function brokenStore(): KVStore {
    return { ...createMemoryKVStore(), increment: () => Promise.reject(new Error("ECONNREFUSED")) };
  }

  // rate-limit.ts's fallback map is module-level state that outlives a test, so
  // every case has to claim an address nobody else used.
  let seq = 0;
  const freshIp = () => `10.0.0.${(seq += 1)}`;

  afterEach(() => vi.useRealTimers());

  it("still limits the auth tier from local memory", async () => {
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 3 } as Env;
    const ip = freshIp();

    const admitted = [];
    for (let i = 0; i < 5; i += 1) {
      admitted.push((await checkRateLimit(storage, ip, "auth", env)).retryAfter === null);
    }

    // Fails closed: an outage must not become an unlimited guessing window.
    expect(admitted).toEqual([true, true, true, false, false]);
  });

  it("still limits the keyCreation tier from local memory", async () => {
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 2 } as Env;
    const ip = freshIp();

    expect((await checkRateLimit(storage, ip, "keyCreation", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, ip, "keyCreation", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, ip, "keyCreation", env)).retryAfter).toBeGreaterThan(0);
  });

  it("fails open for the general tier rather than taking the library down", async () => {
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_GENERAL_LIMIT: 2 } as Env;
    const ip = freshIp();

    for (let i = 0; i < 6; i += 1) {
      const { retryAfter, limit } = await checkRateLimit(storage, ip, "general", env);
      expect(retryAfter).toBeNull();
      expect(limit).toBe(2);
    }
  });

  it("reports the fallback's own remaining budget, not the store's", async () => {
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 4 } as Env;
    const ip = freshIp();

    expect(await checkRateLimit(storage, ip, "auth", env)).toMatchObject({
      remaining: 3,
      limit: 4,
      resetIn: 60,
    });
    expect(await checkRateLimit(storage, ip, "auth", env)).toMatchObject({ remaining: 2 });
  });

  it("opens a fresh fallback window once the old one expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 1 } as Env;
    const ip = freshIp();

    expect((await checkRateLimit(storage, ip, "auth", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, ip, "auth", env)).retryAfter).toBeGreaterThan(0);

    vi.advanceTimersByTime(61_000);

    expect((await checkRateLimit(storage, ip, "auth", env)).retryAfter).toBeNull();
  });

  it("does not extend the fallback window on every hit", async () => {
    // Same fixed-window property the Redis script has: a client hammering the
    // endpoint must not keep pushing its own reset out of reach.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 1 } as Env;
    const ip = freshIp();

    await checkRateLimit(storage, ip, "auth", env);
    vi.advanceTimersByTime(50_000);
    await checkRateLimit(storage, ip, "auth", env);
    vi.advanceTimersByTime(11_000);

    // 61s after the FIRST hit, so the window is gone despite the later one.
    expect((await checkRateLimit(storage, ip, "auth", env)).retryAfter).toBeNull();
  });

  it("keeps one address's outage budget separate from another's", async () => {
    const storage = brokenStore();
    const env = { ...ENV, LIBRIS_RATELIMIT_AUTH_LIMIT: 1 } as Env;
    const [a, b] = [freshIp(), freshIp()];

    expect((await checkRateLimit(storage, a, "auth", env)).retryAfter).toBeNull();
    expect((await checkRateLimit(storage, a, "auth", env)).retryAfter).toBeGreaterThan(0);
    // b is a different person and must not inherit a's exhausted budget.
    expect((await checkRateLimit(storage, b, "auth", env)).retryAfter).toBeNull();
  });
});
