import { describe, expect, it } from "vite-plus/test";
import { createRequestRedis } from "./redis.js";

describe("request-path Redis", () => {
  it("rejects commands promptly when Redis is unavailable", async () => {
    const redis = createRequestRedis({ host: "127.0.0.1", port: 1 });
    const startedAt = Date.now();

    await expect(redis.get("unreachable")).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    redis.disconnect();
  });
});
