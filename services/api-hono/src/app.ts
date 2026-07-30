import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { createNodeWebSocket } from "@hono/node-ws";
import { honoLogLayer } from "@loglayer/hono";
import type { AppVariables } from "./context.js";
import type { AppServices } from "./bootstrap.js";
import type { Env } from "./env.js";
import { compress } from "hono/compress";
import { securityHeaders } from "./middleware/security-headers.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { bodyLimitMiddleware } from "./middleware/body-limit.js";
import { authMiddleware } from "./middleware/auth.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { createRouter } from "./routes/index.js";
import { root, getLogger } from "./lib/logger.js";

export interface CreateAppOptions {
  services: AppServices;
  env: Env;
}

export function createApp({ services, env }: CreateAppOptions) {
  const app = new OpenAPIHono<{ Variables: AppVariables }>({
    strict: false,
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "Validation failed", issues: result.error.issues }, 400);
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Inject services into every request context
  app.use("*", async (c, next) => {
    c.set("db", services.db);
    c.set("queues", services.queues);
    c.set("env", env);
    c.set("redisStorage", services.redisStorage);
    c.set("cacheStorage", services.cacheStorage);
    await next();
  });

  // Middleware stack (order matters)
  app.use("*", compress());
  app.use(
    "*",
    honoLogLayer({
      instance: root,
      autoLogging: {
        request: { logLevel: "debug" },
        response: { logLevel: "info" },
        ignore: ["/api/health"],
      },
    }),
  );
  app.use("*", securityHeaders);
  app.use("*", rateLimitMiddleware);
  app.use("*", bodyLimitMiddleware);
  app.use("*", authMiddleware);

  // Global error handler — always return JSON, preserving custom headers
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // Preserve custom headers (e.g. Retry-After from rate limiting)
      const errResponse = err.getResponse();
      const headers: Record<string, string> = {};
      errResponse.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return c.json({ error: err.message }, { status: err.status, headers });
    }
    const appLogger = getLogger("app");
    if (err instanceof Error) {
      appLogger.withError(err).error("Unhandled error");
    } else {
      appLogger.withMetadata({ error: err }).error("Unhandled error");
    }
    return c.json({ error: "Internal server error" }, 500);
  });

  // Mount routes
  const router = createRouter(upgradeWebSocket);
  app.route("/", router);

  // Serve static SPA files (production only — dev uses Nuxt devServer)
  app.use("*", serveStatic({ root: "./public" }));

  // SPA fallback — any unmatched route gets index.html for client-side routing
  app.get("*", serveStatic({ root: "./public", path: "index.html" }));

  return { app, injectWebSocket };
}

export type AppType = ReturnType<typeof createApp>;
