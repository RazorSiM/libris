import type { Server, ServerOptions } from "node:http";
import type { Env } from "../env.js";

type HttpTimeoutConfig = Pick<
  Env,
  | "LIBRIS_HTTP_HEADERS_TIMEOUT_MS"
  | "LIBRIS_HTTP_REQUEST_TIMEOUT_MS"
  | "LIBRIS_HTTP_IDLE_TIMEOUT_MS"
>;

/** Build explicit transport bounds for Node's HTTP server. */
export function getHttpServerOptions(env: HttpTimeoutConfig): ServerOptions {
  return {
    headersTimeout: env.LIBRIS_HTTP_HEADERS_TIMEOUT_MS,
    requestTimeout: env.LIBRIS_HTTP_REQUEST_TIMEOUT_MS,
    // Node checks incomplete headers and bodies on an interval. Its 30-second
    // default would make a 10-second deadline misleading, so keep enforcement
    // granularity at one second or below for tighter custom limits.
    connectionsCheckingInterval: Math.min(
      1_000,
      env.LIBRIS_HTTP_HEADERS_TIMEOUT_MS,
      env.LIBRIS_HTTP_REQUEST_TIMEOUT_MS,
    ),
  };
}

/** Close sockets that remain inactive beyond the configured idle deadline. */
export function configureHttpIdleTimeout(server: Server, env: HttpTimeoutConfig): void {
  server.setTimeout(env.LIBRIS_HTTP_IDLE_TIMEOUT_MS, (socket) => socket.destroy());
}
