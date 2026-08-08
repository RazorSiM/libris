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

  it("opens the connection at creation instead of on the first command", () => {
    // `lazyConnect` leaves the client in status "wait" until
    // something asks it for a command, and ioredis' sendCommand forces
    // `writable = false` while `this.stream` is still undefined. Combined with
    // `enableOfflineQueue: false` that made the FIRST command after every boot
    // reject with "Stream isn't writeable and enableOfflineQueue options is
    // false" — whether or not Redis was reachable — which surfaced as a
    // spurious 401 on the first authenticated request after each restart.
    //
    // Asserting on the status rather than on a command is the point: the bug is
    // that nothing had started the connection, and "wait" is exactly that state.
    const redis = createRequestRedis({ host: "127.0.0.1", port: 1 });

    expect(redis.status).not.toBe("wait");

    redis.disconnect();
  });

  it("keeps request-path commands fast-failing rather than queued", () => {
    // The eager connect must not have been bought by turning the offline queue
    // back on: a queued command would sit behind a reconnect for far longer
    // than a request handler can wait.
    const redis = createRequestRedis({ host: "127.0.0.1", port: 1 });

    expect(redis.options.enableOfflineQueue).toBe(false);
    expect(redis.options.commandTimeout).toBe(250);

    redis.disconnect();
  });

  it("does not reject the process when the initial connect fails", async () => {
    // Redis is not required for the process to come up. An uncaught rejection
    // from the eager connect would take the whole server down at boot for a
    // dependency every caller is written to degrade without.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const redis = createRequestRedis({ host: "127.0.0.1", port: 1 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      redis.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(rejections).toEqual([]);
  });
});
