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
      /**
       * Refuse anything that is not a WebSocket handshake, before any slot is
       * reserved (libris-59m.17).
       *
       * `upgradeWebSocket` runs this callback on EVERY GET to /api/events —
       * hono/ws is `const events = await createEvents(c); const result = await
       * handler(c, events, options); if (result) return result; await next();`,
       * and the node-ws handler returns undefined for a request with no
       * `Upgrade: websocket`. On such a request onOpen/onClose/onError never
       * fire, so nothing released the slot except the 10 s reservation timer.
       *
       * Five plain `curl /api/events` in under a second therefore exhausted one
       * principal's cap and kept their real browser socket 429'd; roughly
       * twenty app passwords pinned the process-wide cap and denied the event
       * stream to everyone — with no WebSocket ever opened. It also stops
       * /api/events falling through to the SPA fallback and answering 200
       * text/html, which was wrong on its own.
       */
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        throw new HTTPException(400, { message: "This endpoint requires a WebSocket upgrade" });
      }

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
      // A pending reservation must never be a reason for the process to stay
      // alive: shutdown should not wait ten seconds per half-open handshake.
      reservationTimeout.unref?.();
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
