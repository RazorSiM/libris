import type Redis from "ioredis";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createMemorySecondaryStorage,
  createRedisSecondaryStorage,
} from "./auth-secondary-storage.js";

describe("createMemorySecondaryStorage", () => {
  it("round-trips a value as the raw string Better Auth stored", async () => {
    const storage = createMemorySecondaryStorage();
    // Better Auth serialises its own payloads. Parsing them here would hand it
    // back an object where it expects a string.
    await storage.set("session:abc", '{"userId":"u1"}');

    expect(await storage.get("session:abc")).toBe('{"userId":"u1"}');
  });

  it("returns null for an unknown key", async () => {
    const storage = createMemorySecondaryStorage();

    expect(await storage.get("nope")).toBeNull();
  });

  it("expires a value once its ttl has passed", async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemorySecondaryStorage();
      await storage.set("k", "v", 60);

      vi.advanceTimersByTime(59_000);
      expect(await storage.get("k")).toBe("v");

      vi.advanceTimersByTime(2_000);
      expect(await storage.get("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a value with no ttl as permanent", async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemorySecondaryStorage();
      await storage.set("k", "v");

      vi.advanceTimersByTime(10 * 365 * 24 * 60 * 60 * 1000);
      expect(await storage.get("k")).toBe("v");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a key", async () => {
    const storage = createMemorySecondaryStorage();
    await storage.set("k", "v");
    await storage.delete("k");

    expect(await storage.get("k")).toBeNull();
  });

  describe("getAndDelete", () => {
    it("returns the value and consumes it, so a single-use token cannot be replayed", async () => {
      const storage = createMemorySecondaryStorage();
      await storage.set("token", "one-shot");

      expect(await storage.getAndDelete?.("token")).toBe("one-shot");
      expect(await storage.get("token")).toBeNull();
    });

    it("returns null for a key that was never set", async () => {
      const storage = createMemorySecondaryStorage();

      expect(await storage.getAndDelete?.("missing")).toBeNull();
    });

    it("returns null for an expired key rather than its stale value", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemorySecondaryStorage();
        await storage.set("token", "stale", 10);
        vi.advanceTimersByTime(11_000);

        expect(await storage.getAndDelete?.("token")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("increment", () => {
    it("creates the counter at 1 and counts up from there", async () => {
      const storage = createMemorySecondaryStorage();

      expect(await storage.increment?.("rl", 60)).toBe(1);
      expect(await storage.increment?.("rl", 60)).toBe(2);
      expect(await storage.increment?.("rl", 60)).toBe(3);
    });

    it("does not extend the window on later increments", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemorySecondaryStorage();

        // This is the property that makes the rate limit a fixed window. If
        // each increment refreshed the TTL, a client hammering the endpoint
        // would keep pushing the reset out and stay blocked forever — and a
        // client pacing itself just under the limit would never reset either.
        await storage.increment?.("rl", 60);
        vi.advanceTimersByTime(30_000);
        await storage.increment?.("rl", 60);
        vi.advanceTimersByTime(31_000);

        // 61s after creation, so the window is gone despite the later bump.
        expect(await storage.increment?.("rl", 60)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts a fresh window after the previous one expired", async () => {
      vi.useFakeTimers();
      try {
        const storage = createMemorySecondaryStorage();
        await storage.increment?.("rl", 10);
        vi.advanceTimersByTime(11_000);

        expect(await storage.increment?.("rl", 10)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("createRedisSecondaryStorage", () => {
  function fakeRedis() {
    return {
      get: vi.fn(async () => null),
      getdel: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
      del: vi.fn(async () => 1),
      eval: vi.fn(async () => 1),
    } as unknown as Redis & {
      get: ReturnType<typeof vi.fn>;
      getdel: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
      eval: ReturnType<typeof vi.fn>;
    };
  }

  it("namespaces every key so auth data cannot collide with the kv/cache stores", async () => {
    const redis = fakeRedis();
    const storage = createRedisSecondaryStorage(redis);

    await storage.get("session:abc");
    await storage.set("session:abc", "v");
    await storage.delete("session:abc");
    await storage.getAndDelete?.("session:abc");

    expect(redis.get).toHaveBeenCalledWith("ba:session:abc");
    expect(redis.set).toHaveBeenCalledWith("ba:session:abc", "v");
    expect(redis.del).toHaveBeenCalledWith("ba:session:abc");
    expect(redis.getdel).toHaveBeenCalledWith("ba:session:abc");
  });

  it("sets a ttl with EX when one is given, and omits it otherwise", async () => {
    const redis = fakeRedis();
    const storage = createRedisSecondaryStorage(redis);

    await storage.set("a", "v", 90);
    expect(redis.set).toHaveBeenCalledWith("ba:a", "v", "EX", 90);

    await storage.set("b", "v");
    expect(redis.set).toHaveBeenLastCalledWith("ba:b", "v");
  });

  it("uses GETDEL so a single-use token cannot be read twice", async () => {
    const redis = fakeRedis();
    redis.getdel.mockResolvedValueOnce("one-shot");
    const storage = createRedisSecondaryStorage(redis);

    // A get-then-del pair would leave a window in which two concurrent
    // requests both see the token as valid.
    expect(await storage.getAndDelete?.("token")).toBe("one-shot");
    expect(redis.getdel).toHaveBeenCalledTimes(1);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("increments in a single round-trip and returns a number", async () => {
    const redis = fakeRedis();
    redis.eval.mockResolvedValueOnce("7");
    const storage = createRedisSecondaryStorage(redis);

    const value = await storage.increment?.("rl", 60);

    // One call rather than INCR followed by EXPIRE: two round-trips would leave
    // a TTL-less counter behind if the process died between them, permanently
    // rate-limiting whoever owned that key. This pins the WIRING — which key it
    // is aimed at, and that it is a single call. What the script does is
    // asserted behaviourally in tests/redis-increment.test.ts.
    expect(value).toBe(7);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [, numKeys, key, ttl] = redis.eval.mock.calls[0] as [string, number, string, string];
    expect(numKeys).toBe(1);
    expect(key).toBe("ba:rl");
    expect(ttl).toBe("60");
  });

  // A test named "only applies the ttl when the counter is created" used to sit
  // here, and its assertion was `script.toContain("if value == 1 then")`
  // (libris-59m.31). String-matching the Lua SOURCE proves the script's text
  // and nothing about its behaviour: any rewrite that kept the substring — or
  // moved it into a comment — passed. Both properties it was reaching for (a
  // concurrent burst returning 1..N exactly once, and later increments not
  // re-arming the TTL) are asserted against a real Redis in
  // tests/redis-increment.test.ts instead.

  it("honours a custom prefix", async () => {
    const redis = fakeRedis();
    const storage = createRedisSecondaryStorage(redis, "auth");

    await storage.get("k");

    expect(redis.get).toHaveBeenCalledWith("auth:k");
  });
});
