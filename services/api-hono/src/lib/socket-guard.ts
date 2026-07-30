import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";
import type { getLogger } from "./logger.js";

type Logger = ReturnType<typeof getLogger>;

/**
 * Prevent benign transport-level socket errors from crashing the process.
 *
 * `@hono/node-server` v2 handles WebSocket upgrades asynchronously: on the
 * server's "upgrade" event it `await`s the Hono fetch handler (running the full
 * middleware stack) before calling `wss.handleUpgrade`. Node removes its own
 * socket error handler when it emits "upgrade", so during that await window the
 * accepted socket has no "error" listener. A client RST inside that window —
 * common when a browser or Playwright closes a page mid-connection to the
 * /api/events WebSocket — surfaces as an unhandled "error" event and exits the
 * whole process ("read ECONNRESET" from TCP.onStreamRead).
 *
 * Transport-level socket errors are not actionable at the application layer
 * (Hono already owns request/response semantics), so we attach a listener to
 * every accepted socket that logs at debug and lets the socket close quietly.
 */
export function guardSocketErrors(server: ServerType, logger: Logger): void {
  server.on("connection", (socket: Socket) => {
    socket.on("error", (err) => {
      logger.withError(err).debug("Ignored socket-level error");
    });
  });
}
