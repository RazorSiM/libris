import { type Context, Hono } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import { createEventsRoutes } from "./events.js";

const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
  return async (c: Context) => {
    await createEvents(c);
    return c.body(null, 101);
  };
}) as unknown as UpgradeWebSocket;

describe("/api/events", () => {
  it("refuses a foreign Origin before upgrading", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("userId", "user-1");
      c.set("role", "user");
      await next();
    });
    app.route("/api/events", createEventsRoutes(upgradeWebSocket));

    const response = await app.request("/api/events", {
      headers: { origin: "https://attacker.example", upgrade: "websocket" },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-site WebSocket rejected");
  });
});
