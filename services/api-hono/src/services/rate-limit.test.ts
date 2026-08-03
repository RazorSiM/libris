import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../env.js";
import { createMemoryKVStore } from "./kv-store.js";
import { checkRateLimit } from "./rate-limit.js";

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
  it("admits exactly the configured limit under concurrency", async () => {
    const storage = createMemoryKVStore();
    const results = await Promise.all(
      Array.from({ length: 1_000 }, () => checkRateLimit(storage, "concurrent", "auth", ENV)),
    );

    expect(results.filter((result) => result.retryAfter === null)).toHaveLength(30);
    expect(results.filter((result) => result.retryAfter !== null)).toHaveLength(970);
  });
});
