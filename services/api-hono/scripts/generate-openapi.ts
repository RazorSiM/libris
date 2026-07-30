/**
 * Generates a static openapi.json from the Hono router's OpenAPI definitions.
 * Used by the docs package at build time.
 */
import { writeFileSync } from "node:fs";
import { createNodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRouter } from "../src/routes/index.js";
import pkg from "../package.json" with { type: "json" };

const { upgradeWebSocket } = createNodeWebSocket({ app: new OpenAPIHono() });
const router = createRouter(upgradeWebSocket);
const doc = router.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "Libris API",
    description: "Self-hosted book management API",
    version: pkg.version,
  },
});

writeFileSync("openapi.json", JSON.stringify(doc, null, 2));
console.log(`Generated openapi.json (v${pkg.version})`);
