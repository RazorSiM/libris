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
import { lastAdminMiddleware } from "./middleware/last-admin.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { createRouter } from "./routes/index.js";
import { root } from "./lib/logger.js";
import { clientIpMiddleware } from "./middleware/client-ip.js";
import { accessLogMiddleware } from "./middleware/access-log.js";
import { withTrustedClientIp } from "./shared/request-ip.js";
import { createOpenApiRouter, toErrorResponse } from "./shared/openapi.js";

export interface CreateAppOptions {
  services: AppServices;
  env: Env;
}

export function createApp({ services, env }: CreateAppOptions) {
  const includeTestRoutes = env.NODE_ENV === "test" || env.E2E_TEST === "1";
  // The hook this installs only ever reaches routes defined directly on this
  // instance; every mounted router installs its own through the same factory.
  const app = createOpenApiRouter<{ Variables: AppVariables }>({ strict: false });

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Inject services into every request context
  app.use("*", async (c, next) => {
    c.set("db", services.db);
    c.set("queues", services.queues);
    c.set("env", env);
    c.set("auth", services.auth);
    c.set("redisStorage", services.redisStorage);
    c.set("cacheStorage", services.cacheStorage);
    await next();
  });

  // Middleware stack (order matters)
  app.use("*", compress());
  app.use("*", clientIpMiddleware);
  app.use(
    "*",
    honoLogLayer({
      instance: root,
      // Built-in auto-logging unconditionally trusts X-Forwarded-For. The
      // middleware below logs the address resolved from the TCP peer instead.
      autoLogging: false,
    }),
  );
  app.use("*", accessLogMiddleware);
  app.use("*", securityHeaders);
  // bodyLimit MUST stay ahead of the rate limiter: the limiter clones and
  // parses the JSON body of the credential endpoints to derive their
  // per-credential bucket, and nothing else in this chain caps a body. With
  // the two the other way round an unauthenticated request was buffered whole,
  // with no size ceiling and no 429 in front of it. Pinned by app.wiring.test.ts.
  app.use("*", bodyLimitMiddleware);
  app.use("*", rateLimitMiddleware);
  app.use("*", authMiddleware);

  // Global error handler — always return JSON, preserving custom headers.
  // Understands hono's HTTPException and better-call's APIError (what every
  // auth.api.* call throws); see shared/openapi.ts.
  app.onError((err, c) => toErrorResponse(err, c));

  // Better Auth's own endpoints, as a catch-all so every current and future
  // endpoint it exposes — including nested plugin routes like
  // /api/auth/admin/* — is reachable without being enumerated here.
  // route-policy.ts gives the same prefix the "skip" policy so authMiddleware
  // does not try to authenticate them first.
  //
  // Registered BEFORE the app router now that the bespoke /api/auth/* routes are
  // gone; it used to sit after them so their exact paths
  // could win over the catch-all.
  //
  // Consequence: a catch-all contributes nothing to Hono's RPC type graph, so
  // there is no typed client for these paths. The frontend talks to them
  // through the Better Auth client instead.
  app.use("/api/auth/admin/set-role", lastAdminMiddleware);
  app.use("/api/auth/admin/ban-user", lastAdminMiddleware);
  app.use("/api/auth/admin/remove-user", lastAdminMiddleware);
  app.on(["GET", "POST"], "/api/auth/*", (c) => {
    const request = new Request(c.req.raw, {
      headers: withTrustedClientIp(c.req.raw.headers, c.get("clientIp")),
    });
    return services.auth.handler(request);
  });

  // Mount routes
  const router = createRouter(upgradeWebSocket, {
    includeTestRoutes,
  });
  app.route("/", router);

  // Serve static SPA files (production only — dev uses Nuxt devServer)
  app.use("*", serveStatic({ root: "./public" }));

  // SPA fallback — any unmatched route gets index.html for client-side routing
  app.get("*", serveStatic({ root: "./public", path: "index.html" }));

  return { app, injectWebSocket };
}

export type AppType = ReturnType<typeof createApp>;
