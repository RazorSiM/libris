import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";
import type { getLogger } from "./logger.js";

type Logger = ReturnType<typeof getLogger>;

/** Limits are per process; the total cap protects the event-bus fan-out. */
export const MAX_EVENT_SOCKET_CONNECTIONS = 100;
export const MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL = 5;

/**
 * Tracks WebSocket upgrade reservations until their connection closes.
 *
 * The route reserves a slot before upgrading, so an over-limit client receives
 * an HTTP error instead of completing a WebSocket handshake and consuming an
 * event-bus listener.
 */
export class SocketConnectionGuard {
  private total = 0;
  private readonly perPrincipal = new Map<string, number>();

  constructor(
    private readonly maxTotal = MAX_EVENT_SOCKET_CONNECTIONS,
    private readonly maxPerPrincipal = MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL,
  ) {}

  tryAcquire(principal: string): (() => void) | null {
    const principalCount = this.perPrincipal.get(principal) ?? 0;
    if (this.total >= this.maxTotal || principalCount >= this.maxPerPrincipal) return null;

    this.total += 1;
    this.perPrincipal.set(principal, principalCount + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = (this.perPrincipal.get(principal) ?? 1) - 1;
      if (remaining === 0) this.perPrincipal.delete(principal);
      else this.perPrincipal.set(principal, remaining);
    };
  }
}

export const eventSocketConnectionGuard = new SocketConnectionGuard();

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
