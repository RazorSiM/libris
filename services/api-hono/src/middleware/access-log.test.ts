import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import { accessLogMiddleware } from "./access-log.js";

describe("accessLogMiddleware", () => {
  it("logs the resolved client address rather than forwarded headers", async () => {
    const metadata: unknown[] = [];
    const builder = { debug: vi.fn(), info: vi.fn() };
    const logger = {
      withMetadata(value: unknown) {
        metadata.push(value);
        return builder;
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("clientIp", "10.0.0.5");
      c.set("logger", logger as never);
      await next();
    });
    app.use("*", accessLogMiddleware);
    app.get("/", (c) => c.text("ok"));

    await app.request("/", { headers: { "x-forwarded-for": "203.0.113.99" } });

    expect(metadata).toHaveLength(2);
    expect(metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          req: expect.objectContaining({ remoteAddress: "10.0.0.5" }),
        }),
      ]),
    );
    expect(JSON.stringify(metadata)).not.toContain("203.0.113.99");
  });
});
