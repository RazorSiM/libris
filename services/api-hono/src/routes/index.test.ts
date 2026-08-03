import { createNodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vite-plus/test";
import { createRouter } from "./index.js";

describe("createRouter", () => {
  it("omits test routes by default", () => {
    const { upgradeWebSocket } = createNodeWebSocket({ app: new OpenAPIHono() });
    const router = createRouter(upgradeWebSocket);

    expect(router.routes.some(({ path }) => path.startsWith("/__test"))).toBe(false);
  });

  it("returns 404 for test paths when they are omitted", async () => {
    const { upgradeWebSocket } = createNodeWebSocket({ app: new OpenAPIHono() });
    const router = createRouter(upgradeWebSocket);

    expect((await router.request("/__test/cleanup", { method: "POST" })).status).toBe(404);
  });

  it("includes test routes only when explicitly requested", () => {
    const { upgradeWebSocket } = createNodeWebSocket({ app: new OpenAPIHono() });
    const router = createRouter(upgradeWebSocket, { includeTestRoutes: true });

    expect(router.routes.some(({ path }) => path === "/__test/cleanup")).toBe(true);
  });
});
