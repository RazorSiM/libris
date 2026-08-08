import type { ServerOptions } from "node:http";
import type { Env } from "../env.js";

type HttpTimeoutConfig = Pick<
  Env,
  | "LIBRIS_HTTP_HEADERS_TIMEOUT_MS"
  | "LIBRIS_HTTP_REQUEST_TIMEOUT_MS"
  | "LIBRIS_HTTP_IDLE_TIMEOUT_MS"
>;

/**
 * Explicit transport bounds for Node's HTTP server.
 *
 * Three deadlines, each bounding a different thing, and none of them bounding
 * how long a handler may take:
 *
 * - `headersTimeout` and `requestTimeout` bound the RECEIVE side. Together they
 *   are the slowloris defence: a client that dribbles out headers or a body
 *   forever is cut off without ever occupying a route for long.
 * - `keepAliveTimeout` is the genuinely idle one. It starts only once a
 *   response has been written and bounds how long the connection may then sit
 *   doing nothing before the next request.
 *
 * `LIBRIS_HTTP_IDLE_TIMEOUT_MS` used to be applied through a separate
 * `configureHttpIdleTimeout(server, env)` calling `server.setTimeout(ms, socket
 * => socket.destroy())` (libris-59m.28). That is a socket INACTIVITY timeout,
 * armed for the entire life of a non-upgraded connection — including the window
 * in which a handler is running and has not yet written any bytes. It is not an
 * idle-connection timeout, which is precisely why Node changed `server.timeout`
 * to default to 0. Because the callback destroyed the socket unconditionally, a
 * slow but legitimate request (an uncached cover proxied from a sluggish CDN, a
 * large multi-file upload) died as a TCP reset: the browser saw
 * ERR_CONNECTION_RESET with no status code, nothing reached the access log, and
 * the handler carried on to write into a dead socket.
 *
 * Node removes its own timeout listener when it emits `upgrade`, so /api/events
 * WebSockets were unaffected before and are unaffected now.
 */
export function getHttpServerOptions(env: HttpTimeoutConfig): ServerOptions {
  return {
    headersTimeout: env.LIBRIS_HTTP_HEADERS_TIMEOUT_MS,
    requestTimeout: env.LIBRIS_HTTP_REQUEST_TIMEOUT_MS,
    // Bounds only the gap BETWEEN requests on a kept-alive connection, so a
    // handler that runs longer than this still gets to answer.
    keepAliveTimeout: env.LIBRIS_HTTP_IDLE_TIMEOUT_MS,
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
