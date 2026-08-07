import { createOpenApiRouter } from "../../shared/openapi.js";
import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../../context.js";
import { onServerEvent } from "../../services/event-bus.js";
import type { UpgradeWebSocket } from "hono/ws";
import { getLogger } from "../../lib/logger.js";
import { apiKeyFromHeaders } from "../../lib/auth.js";
import { isTrustedOrigin } from "../../middleware/auth.js";
import { eventSocketConnectionGuard } from "../../lib/socket-guard.js";
import { getUserId, isAdmin } from "../../shared/auth.js";

const logger = getLogger("ws");

export function createEventsRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return createOpenApiRouter<{ Variables: AppVariables }>().get(
    "/",
    upgradeWebSocket(async (c) => {
      const origin = c.req.header("origin");
      if (origin && !isTrustedOrigin(origin, c, c.get("env"))) {
        throw new HTTPException(403, { message: "Cross-site WebSocket rejected" });
      }

      const userId = getUserId(c);
      const appPassword = apiKeyFromHeaders(c.req.raw.headers);
      // A browser session is limited per user. App-password clients are limited
      // per credential without retaining or logging the raw secret.
      const principal = appPassword
        ? `api-key:${createHash("sha256").update(appPassword).digest("base64url")}`
        : `user:${userId}`;
      const release = eventSocketConnectionGuard.tryAcquire(principal);
      if (!release) {
        throw new HTTPException(429, { message: "Too many WebSocket connections" });
      }

      // The node WebSocket adapter does not invoke onClose when a client drops
      // between reservation and handshake, so avoid keeping a stale slot forever.
      let opened = false;
      const reservationTimeout = setTimeout(() => {
        if (!opened) release();
      }, 10_000);
      const bookIdFilter = (c.req.query("bookId") as string) || null;

      return {
        onOpen(_evt, ws) {
          opened = true;
          clearTimeout(reservationTimeout);
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));

          const unsub = onServerEvent(
            (event) => {
              if (bookIdFilter && event.bookId && event.bookId !== bookIdFilter) return;
              try {
                const { userId: _userId, ...clientEvent } = event;
                ws.send(JSON.stringify(clientEvent));
              } catch {
                // client disconnected
              }
            },
            { userId, isAdmin: isAdmin(c) },
          );

          // Store unsub on the ws context for cleanup
          (ws as any)._unsub = unsub;
        },
        onMessage(evt, ws) {
          // Handle ping from client heartbeat
          if (evt.data === "ping") {
            ws.send("pong");
          }
        },
        onClose(_evt, ws) {
          const unsub = (ws as any)._unsub;
          if (typeof unsub === "function") unsub();
          release();
          logger.debug("WebSocket client disconnected");
        },
        onError(_evt, ws) {
          const unsub = (ws as any)._unsub;
          if (typeof unsub === "function") unsub();
          release();
        },
      };
    }),
  );
}
