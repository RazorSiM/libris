import { type Context, Hono } from "hono";
import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import { MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL } from "../../lib/socket-guard.js";
import { createEventsRoutes } from "./events.js";

/**
 * Stands in for @hono/node-ws's upgradeWebSocket.
 *
 * The ordering matters: hono/ws runs `createEvents(c)` FIRST and only then
 * hands the result to the transport handler, which is exactly why a request
 * that will never become a socket still ran the whole reservation path. Keeping
 * that ordering here is what lets this suite see libris-59m.17 at all.
 *
 * A real handshake answers 101, but `new Response` refuses a status below 200,
 * so acceptance is signalled with a header instead of the wire status.
 */
const ACCEPTED = "x-ws-accepted";

const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
  return async (c: Context) => {
    await createEvents(c);
    return new Response(null, { status: 200, headers: { [ACCEPTED]: "1" } });
  };
}) as unknown as UpgradeWebSocket;

/** Whether the request got past `createEvents` and would have become a socket. */
function wasAccepted(response: Response): boolean {
  return response.headers.get(ACCEPTED) === "1";
}

/**
 * A bare app whose principal is a caller-chosen user id.
 *
 * Every test uses a distinct id because `eventSocketConnectionGuard` is a
 * module-level singleton whose slots are only returned by onClose/onError —
 * neither of which the fake upgrade above ever fires — so budgets would
 * otherwise leak between tests.
 */
function appForUser(userId: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("role", "user");
    await next();
  });
  app.route("/api/events", createEventsRoutes(upgradeWebSocket));
  return app;
}

const UPGRADE = { upgrade: "websocket" } as const;

describe("/api/events", () => {
  it("refuses a foreign Origin before upgrading", async () => {
    const app = appForUser("origin-check-user");

    const response = await app.request("/api/events", {
      headers: { origin: "https://attacker.example", ...UPGRADE },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-site WebSocket rejected");
  });

  it("refuses a plain GET that carries no Upgrade header", async () => {
    const app = appForUser("plain-get-user");

    const response = await app.request("/api/events");

    // 400, not 200: without this the request fell through to the SPA fallback
    // and an /api/ path answered 200 text/html.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("WebSocket upgrade");
  });

  it("does not spend a connection slot on a plain GET", async () => {
    // The libris-59m.17 regression test.
    //
    // `createEvents` reserves a slot, and only onOpen/onClose/onError give it
    // back — none of which fires for a request that never becomes a socket. The
    // sole other release was a 10 s reservation timer, so N plain curls burned
    // N slots for ten seconds apiece.
    //
    // Exhausting the whole per-principal budget with plain GETs and then
    // opening a real socket is what pins that down: with the upgrade check
    // removed, the reservations from the loop are all still held and this
    // upgrade answers 429 instead of completing. Nothing here waits for the
    // reservation timer, so it also proves the slot was never taken rather than
    // taken and returned late.
    const app = appForUser("slot-leak-user");

    // Deliberately unasserted: what these requests ANSWER is the previous
    // test's subject. What matters here is only what they leave behind.
    for (let i = 0; i < MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL; i++) {
      await app.request("/api/events");
    }

    const upgraded = await app.request("/api/events", { headers: UPGRADE });

    expect(wasAccepted(upgraded)).toBe(true);
    expect(upgraded.status).not.toBe(429);
  });

  it("still caps concurrent sockets for one principal", async () => {
    // The cap itself is unchanged; only the accounting of what counts as a
    // connection moved.
    const app = appForUser("capped-user");

    for (let i = 0; i < MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL; i++) {
      const accepted = await app.request("/api/events", { headers: UPGRADE });
      expect(wasAccepted(accepted)).toBe(true);
    }

    const refused = await app.request("/api/events", { headers: UPGRADE });

    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("Too many WebSocket connections");
  });

  it("accepts an Upgrade header regardless of case", async () => {
    // Browsers send "websocket"; RFC 6455 leaves the token case-insensitive and
    // intermediaries do rewrite it to "WebSocket". Rejecting those would break
    // real clients in the name of fixing a leak.
    const app = appForUser("mixed-case-user");

    const response = await app.request("/api/events", { headers: { upgrade: "WebSocket" } });

    expect(wasAccepted(response)).toBe(true);
  });
});
