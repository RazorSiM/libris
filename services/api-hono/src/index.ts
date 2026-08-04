import { shutdownOtel } from "./otel.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { getEnv } from "./env.js";
import { getLogger } from "./lib/logger.js";
import { guardSocketErrors } from "./lib/socket-guard.js";
import { configureHttpIdleTimeout, getHttpServerOptions } from "./lib/http-timeouts.js";

const logger = getLogger("server");
const env = getEnv();
const services = await bootstrap(env);
const { app, injectWebSocket } = createApp({ services, env });

const server = serve(
  { fetch: app.fetch, port: env.PORT, serverOptions: getHttpServerOptions(env) },
  (info) => {
    logger.info(`Listening on http://localhost:${info.port}`);
  },
);
configureHttpIdleTimeout(server as Parameters<typeof configureHttpIdleTimeout>[0], env);

// Keep transport-level socket errors (e.g. client RST during the async WS
// upgrade window) from crashing the process. Must be attached before WebSocket
// upgrades start flowing. See guardSocketErrors for the full rationale.
guardSocketErrors(server, logger);

injectWebSocket(server);

const shutdown = async () => {
  logger.info("Received shutdown signal...");
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await services.shutdown();
  await shutdownOtel();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
