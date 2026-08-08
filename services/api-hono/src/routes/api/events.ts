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
import {
  eventSocketRegistry,
  EVENT_SOCKET_REVALIDATE_INTERVAL_MS,
  EVENT_SOCKET_REVOKED_CLOSE_CODE,
} from "../../lib/event-socket-registry.js";
import { getUserId, isAdmin } from "../../shared/auth.js";
import { isUserBanned } from "../../shared/user-ban.js";
import { sessionHeaders } from "../../shared/request-ip.js";

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

      const auth = c.get("auth");
      const admin = isAdmin(c);
      /**
       * The credential, detached from the request.
       *
       * `c.req.raw` does not outlive the upgrade, but a Headers copy does, and
       * it is the only thing a re-validation needs. `sessionHeaders` is used
       * here for the same reason every other Better Auth call site uses it:
       * Better Auth reads the client address from a private header, and handing
       * it the raw client-supplied one would let a socket re-validate itself
       * under a forged address.
       */
      const credentialHeaders = sessionHeaders(c);

      /**
       * What this socket's credential resolves to RIGHT NOW.
       *
       * Three outcomes, and the third is the one that matters:
       *  - a session      — still authenticated.
       *  - null           — definitively revoked. `getSession` answers null for
       *                     a session that is gone, and throws an APIError for
       *                     a credential that was presented and rejected (an
       *                     unknown or disabled app password).
       *  - undefined      — could not tell. An infrastructure fault (Redis or
       *                     Postgres unreachable) is not a verdict on the
       *                     credential (libris-59m.15), and severing every open
       *                     socket in the install because a cache blinked would
       *                     turn a degraded store into an outage.
       *
       * `disableRefresh` keeps this from being a keep-alive: without it, an
       * abandoned tab would renew its own session forever just by holding a
       * socket open.
       */
      const resolveCurrentSession = async () => {
        try {
          return await auth.api.getSession({
            headers: credentialHeaders,
            query: { disableRefresh: true },
          });
        } catch (err) {
          if (err instanceof Error && err.name === "APIError") return null;
          logger
            .withError(err instanceof Error ? err : new Error(String(err)))
            .warn("Event socket re-validation failed — auth store unavailable, socket kept open");
          return undefined;
        }
      };

      /**
       * The session token this socket is bound to, so a revocation of THIS
       * session closes THIS socket and leaves the user's other devices alone.
       *
       * Deliberately null for an app password: the apiKey plugin's synthesised
       * session carries the raw key as its `token`, and that secret must not be
       * parked in a process-wide registry. Those sockets are reached through
       * the user-level closes (ban, account removal) and by re-validation.
       */
      const sessionToken = appPassword
        ? null
        : ((await resolveCurrentSession())?.session.token ?? null);

      // ── Per-connection state ────────────────────────────────────────────
      // Held in this closure rather than stashed on the `ws` object: hono/ws
      // calls this factory once per connection, so the closure IS the
      // connection's scope.
      let unsub: (() => void) | undefined;
      let revalidateTimer: ReturnType<typeof setInterval> | undefined;
      let unregister: (() => void) | undefined;
      let tornDown = false;

      const teardown = (): void => {
        if (tornDown) return;
        tornDown = true;
        unsub?.();
        if (revalidateTimer) clearInterval(revalidateTimer);
        unregister?.();
        release();
      };

      return {
        onOpen(_evt, ws) {
          opened = true;
          clearTimeout(reservationTimeout);
          ws.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));

          unsub = onServerEvent(
            (event) => {
              if (bookIdFilter && event.bookId && event.bookId !== bookIdFilter) return;
              try {
                const { userId: _userId, ...clientEvent } = event;
                ws.send(JSON.stringify(clientEvent));
              } catch {
                // client disconnected
              }
            },
            { userId, isAdmin: admin },
          );

          /**
           * Stop the subscription BEFORE closing the transport.
           *
           * `ws.close()` is a handshake, not an instant cut: the socket stays
           * writable until the peer answers, so a fan-out landing in that
           * window would still be delivered to a revoked principal. Tearing the
           * event-bus listener down first makes "closed" mean "receives
           * nothing", which is the property the fix is actually about.
           */
          const closeRevoked = (reason: string): void => {
            teardown();
            try {
              ws.close(EVENT_SOCKET_REVOKED_CLOSE_CODE, reason);
            } catch {
              // Already gone at the transport level; the subscription is what
              // mattered and it is already released.
            }
            logger.info(`Event socket for ${userId} closed: ${reason}`);
          };

          // Eager close: lib/auth.ts closes this the moment Better Auth deletes
          // the session row, bans the account or removes the user.
          unregister = eventSocketRegistry.register({ userId, sessionToken, close: closeRevoked });

          /**
           * Backstop for everything the hooks cannot see — expiry, a disabled
           * app password, a revocation served by another process. See
           * EVENT_SOCKET_REVALIDATE_INTERVAL_MS.
           *
           * A demotion counts as a revocation too: `isAdmin` is baked into the
           * event-bus filter at upgrade, so an ex-admin's socket would keep
           * receiving every book event on the install. Closing makes the client
           * re-dial and be re-scoped.
           */
          revalidateTimer = setInterval(() => {
            void (async () => {
              const current = await resolveCurrentSession();
              if (current === undefined) return;
              if (current === null) return closeRevoked("session revoked");
              if (isUserBanned(current.user)) return closeRevoked("account banned");
              if (current.user.id !== userId) return closeRevoked("identity changed");
              if ((current.user.role === "admin") !== admin) return closeRevoked("role changed");
            })();
          }, EVENT_SOCKET_REVALIDATE_INTERVAL_MS);
          // Never a reason to keep the process alive.
          revalidateTimer.unref?.();
        },
        onMessage(evt, ws) {
          // Handle ping from client heartbeat
          if (evt.data === "ping") {
            ws.send("pong");
          }
        },
        onClose() {
          teardown();
          logger.debug("WebSocket client disconnected");
        },
        onError() {
          teardown();
        },
      };
    }),
  );
}
