/**
 * Lightweight server that only serves the OpenAPI spec.
 * Used by scripts/bruno-import.sh -- no DB, Redis, or env vars needed.
 */
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRouter } from "./routes/index.js";

const tempApp = new OpenAPIHono();
const { upgradeWebSocket } = createNodeWebSocket({ app: tempApp });
const router = createRouter(upgradeWebSocket);

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: router.fetch, port }, (info) => {
  console.log(`OpenAPI server listening on http://localhost:${info.port}`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
