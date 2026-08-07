import type { PGlite } from "@electric-sql/pglite";
import type Redis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAuth } from "../lib/auth.js";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import type { Env } from "../env.js";
import {
  createMemorySecondaryStorage,
  createRedisSecondaryStorage,
  resetSecondaryStorageFallback,
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

  it("increments in a single scripted round-trip and returns a number", async () => {
    const redis = fakeRedis();
    redis.eval.mockResolvedValueOnce("7");
    const storage = createRedisSecondaryStorage(redis);

    const value = await storage.increment?.("rl", 60);

    // One EVAL rather than INCR followed by EXPIRE: two round-trips would leave
    // a TTL-less counter behind if the process died between them, permanently
    // rate-limiting whoever owned that key.
    expect(value).toBe(7);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, ttl] = redis.eval.mock.calls[0] as [
      string,
      number,
      string,
      string,
    ];
    expect(script).toContain("INCR");
    expect(script).toContain("EXPIRE");
    expect(numKeys).toBe(1);
    expect(key).toBe("ba:rl");
    expect(ttl).toBe("60");
  });

  it("only applies the ttl when the counter is created", async () => {
    const redis = fakeRedis();
    const storage = createRedisSecondaryStorage(redis);
    await storage.increment?.("rl", 60);

    const [script] = redis.eval.mock.calls[0] as [string];
    // The EXPIRE is guarded on the post-increment value being 1.
    expect(script.replace(/\s+/g, " ")).toContain("if value == 1 then");
  });

  it("honours a custom prefix", async () => {
    const redis = fakeRedis();
    const storage = createRedisSecondaryStorage(redis, "auth");

    await storage.get("k");

    expect(redis.get).toHaveBeenCalledWith("auth:k");
  });

  /**
   * libris-59m.15. The request-path client carries `commandTimeout: 250` and
   * `enableOfflineQueue: false`, so any Redis pause above 250 ms — BGSAVE, an
   * AOF rewrite, a failover, a restart — turns every command into a rejection.
   *
   * A THROW is strictly worse than a MISS here, because better-auth's
   * `findSession` only reaches its Postgres fallback when secondary storage
   * answers null.
   */
  describe("when the Redis client rejects every command", () => {
    function rejectingRedis() {
      const boom = async () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      };
      return {
        get: vi.fn(boom),
        getdel: vi.fn(boom),
        set: vi.fn(boom),
        del: vi.fn(boom),
        eval: vi.fn(boom),
      } as unknown as Redis;
    }

    it("degrades `get` to a miss so the database fallback can run", async () => {
      const storage = createRedisSecondaryStorage(rejectingRedis());

      // Before the fix this rejected, `findSession` threw before its fallback,
      // and authMiddleware's .catch(() => null) turned it into a 401.
      await expect(storage.get("session:abc")).resolves.toBeNull();
    });

    it("degrades `getAndDelete` to a miss, which refuses the token rather than replaying it", async () => {
      const storage = createRedisSecondaryStorage(rejectingRedis());

      await expect(storage.getAndDelete?.("token")).resolves.toBeNull();
    });

    it("still reports `set` and `delete` failures", async () => {
      const storage = createRedisSecondaryStorage(rejectingRedis());

      // A silently dropped delete is a revocation that did not happen. Both of
      // these must stay loud even though the reads above went quiet.
      await expect(storage.set("k", "v")).rejects.toThrow(/enableOfflineQueue/);
      await expect(storage.delete("k")).rejects.toThrow(/enableOfflineQueue/);
    });

    it("counts `increment` in process memory instead of throwing out of onRequest", async () => {
      resetSecondaryStorageFallback();
      const storage = createRedisSecondaryStorage(rejectingRedis());

      // better-auth calls increment from its rate limiter's onRequest and does
      // not catch, so a rejection here 500s /api/auth/* — get-session included.
      // Falling back must not fail OPEN: the counter has to keep climbing, or
      // an attacker gets an unlimited credential-guessing budget for as long as
      // Redis is down.
      expect(await storage.increment?.("ratelimit:1.2.3.4", 60)).toBe(1);
      expect(await storage.increment?.("ratelimit:1.2.3.4", 60)).toBe(2);
      expect(await storage.increment?.("ratelimit:1.2.3.4", 60)).toBe(3);
      // A different key keeps its own budget.
      expect(await storage.increment?.("ratelimit:5.6.7.8", 60)).toBe(1);
    });

    it("does not hand out a fresh window each time a new storage is built", async () => {
      resetSecondaryStorageFallback();

      // A flapping Redis rebuilds nothing, but the counter must survive
      // reconnects regardless — otherwise every blip resets the budget.
      await createRedisSecondaryStorage(rejectingRedis()).increment?.("ratelimit:9.9.9.9", 60);
      const second = await createRedisSecondaryStorage(rejectingRedis()).increment?.(
        "ratelimit:9.9.9.9",
        60,
      );

      expect(second).toBe(2);
    });
  });
});

/**
 * The end-to-end shape of libris-59m.15: a session that exists in Postgres must
 * keep authenticating while Redis is unavailable.
 *
 * This drives a real Better Auth instance over PGlite rather than asserting on
 * the storage adapter alone, because the property under test belongs to the
 * seam between the two — `session.storeSessionInDatabase` is true and
 * `preserveSessionInDatabase` is unset, so `findSession` falls through to the
 * `sessions` row when (and only when) secondary storage answers null.
 */
describe("a Redis outage against a durable session", () => {
  const TEST_ENV = {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "pglite://",
    REDIS_URL: "redis://localhost:6379",
    LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
    LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
    LIBRIS_COVER_FETCH_ALLOWLIST: [],
    API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
    BETTER_AUTH_URL: "",
    LIBRIS_COOKIE_SECURE: "0",
    MIGRATIONS_PATH: "./migrations",
    TRUST_PROXY_HEADERS: "0",
    LIBRIS_TRUSTED_PROXIES: [],
    E2E_TEST: "",
    LOG_LEVEL: "info",
    LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
    LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
    LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
    LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
    LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
    LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
    LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
  } satisfies Env;

  const PASSWORD = "correct-horse-battery-staple";

  /** A Map-backed stand-in for ioredis that can be told to start failing. */
  function faultInjectableRedis() {
    const data = new Map<string, string>();
    let failing = false;
    const guard = () => {
      if (failing) {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
    };
    return {
      breakIt: () => {
        failing = true;
      },
      client: {
        async get(key: string) {
          guard();
          return data.get(key) ?? null;
        },
        async getdel(key: string) {
          guard();
          const value = data.get(key) ?? null;
          data.delete(key);
          return value;
        },
        async set(key: string, value: string) {
          guard();
          data.set(key, value);
          return "OK";
        },
        async del(key: string) {
          guard();
          return data.delete(key) ? 1 : 0;
        },
        async eval() {
          guard();
          return 1;
        },
      } as unknown as Redis,
    };
  }

  let pglite: PGlite;
  let db: TestDb;
  let redis: ReturnType<typeof faultInjectableRedis>;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    ({ pglite, db } = await createTestDb());
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(() => {
    redis = faultInjectableRedis();
    auth = createAuth({
      db: db as unknown as Parameters<typeof createAuth>[0]["db"],
      secondaryStorage: createRedisSecondaryStorage(redis.client),
      env: TEST_ENV,
      secret: TEST_ENV.BETTER_AUTH_SECRET,
      baseURL: "http://localhost:3000",
    });
  });

  it("keeps authenticating an existing session once Redis starts rejecting", async () => {
    const email = `redis-outage-${Date.now()}@example.test`;
    await auth.api.createUser({
      body: { email, password: PASSWORD, name: "Outage", role: "user" },
    });
    const { headers } = await auth.api.signInEmail({
      body: { email, password: PASSWORD },
      returnHeaders: true,
    });
    const cookie = headers.getSetCookie().join("; ");

    // Sanity: the session resolves while Redis is healthy.
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();

    redis.breakIt();

    // The assertion that fails against the old adapter: with `get` propagating
    // the rejection, this call THREW, `findSession` never reached the Postgres
    // `sessions` row, and every logged-in user saw a 401 for the duration of
    // the outage.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(email);
  });
});
