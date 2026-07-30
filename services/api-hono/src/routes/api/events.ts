import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../../context.js";
import { onServerEvent } from "../../services/event-bus.js";
import type { UpgradeWebSocket } from "hono/ws";
import { getLogger } from "../../lib/logger.js";

const logger = getLogger("ws");

export function createEventsRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new OpenAPIHono<{ Variables: AppVariables }>().get(
    "/",
    upgradeWebSocket((c) => {
      const bookIdFilter = (c.req.query("bookId") as string) || null;

      return {
        onOpen(_evt, ws) {
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));

          const unsub = onServerEvent((event) => {
            if (bookIdFilter && event.bookId && event.bookId !== bookIdFilter) return;
            try {
              ws.send(JSON.stringify(event));
            } catch {
              // client disconnected
            }
          });

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
          logger.debug("WebSocket client disconnected");
        },
        onError(_evt, ws) {
          const unsub = (ws as any)._unsub;
          if (typeof unsub === "function") unsub();
        },
      };
    }),
  );
}
