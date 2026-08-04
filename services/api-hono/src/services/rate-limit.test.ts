import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Env } from "../env.js";
import { createMemoryKVStore } from "./kv-store.js";
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

  it("admits exactly the configured limit under concurrency", async () => {
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
