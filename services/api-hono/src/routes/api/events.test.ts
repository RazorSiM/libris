import { type Context, Hono } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppVariables } from "../../context.js";
import type { Auth } from "../../lib/auth.js";
import { MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL } from "../../lib/socket-guard.js";
import {
  eventSocketRegistry,
  EVENT_SOCKET_REVALIDATE_INTERVAL_MS,
  EVENT_SOCKET_RESCOPE_CLOSE_CODE,
  EVENT_SOCKET_REVOKED_CLOSE_CODE,
} from "../../lib/event-socket-registry.js";
import { publishEvent } from "../../services/event-bus.js";
import { createEventsRoutes } from "./events.js";

/**
 * Stands in for @hono/node-ws's upgradeWebSocket.
 *
 * The ordering matters: hono/ws runs `createEvents(c)` FIRST and only then
 * hands the result to the transport handler, which is exactly why a request
 * that will never become a socket still ran the whole reservation path. Keeping
 * that ordering here is what lets this suite see the slot leak at all.
 *
 * The handlers `createEvents` returns are stashed on the response so a test can
 * drive onOpen/onClose the way the transport would — without that, nothing past
 * the reservation path is reachable at all.
 *
 * A real handshake answers 101, but `new Response` refuses a status below 200,
 * so acceptance is signalled with a header instead of the wire status.
 */
const ACCEPTED = "x-ws-accepted";

const handlersByResponse = new WeakMap<Response, WSEvents>();

const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
  return async (c: Context) => {
    const handlers = await createEvents(c);
    const response = new Response(null, { status: 200, headers: { [ACCEPTED]: "1" } });
    handlersByResponse.set(response, handlers);
    return response;
  };
}) as unknown as UpgradeWebSocket;

/** Whether the request got past `createEvents` and would have become a socket. */
function wasAccepted(response: Response): boolean {
  return response.headers.get(ACCEPTED) === "1";
}

/** A stand-in WebSocket that records what the route sent it and how it ended. */
function fakeWs() {
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    send: (data: unknown) => {
      sent.push(String(data));
    },
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
    },
  } as unknown as WSContext;
  return { ws, sent, closes };
}

/**
 * A bare app whose principal is a caller-chosen user id.
 *
 * Every test uses a distinct id because `eventSocketConnectionGuard` is a
 * module-level singleton whose slots are only returned by onClose/onError, so
 * budgets would otherwise leak between tests.
 *
 * `auth` is only ever asked for a session: the route re-validates an open
 * socket against the authoritative store, so a stub that answers that one
 * question is the whole surface it needs.
 */
function appForUser(
  userId: string,
  getSession: (() => unknown) | null = () => ({
    session: { token: `token-for-${userId}` },
    user: { id: userId, role: "user" },
  }),
  role = "user",
) {
  const calls = { getSession: 0 };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("role", role);
    c.set("clientIp", "203.0.113.7");
    c.set("auth", {
      api: {
        getSession: async () => {
          calls.getSession += 1;
          if (!getSession) throw new Error("auth store unavailable");
          return getSession();
        },
      },
    } as unknown as Auth);
    await next();
  });
  app.route("/api/events", createEventsRoutes(upgradeWebSocket));
  return { app, calls };
}

const UPGRADE = { upgrade: "websocket" } as const;

/** Upgrade and drive the handshake to an open socket, as the transport would. */
async function openSocket(app: Hono<{ Variables: AppVariables }>) {
  const response = await app.request("/api/events", { headers: UPGRADE });
  const handlers = handlersByResponse.get(response);
  if (!handlers) throw new Error("upgrade was refused");
  const socket = fakeWs();
  handlers.onOpen?.(new Event("open"), socket.ws);
  return { ...socket, handlers };
}

describe("/api/events", () => {
  it("refuses a foreign Origin before upgrading", async () => {
    const { app } = appForUser("origin-check-user");

    const response = await app.request("/api/events", {
      headers: { origin: "https://attacker.example", ...UPGRADE },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-site WebSocket rejected");
  });

  it("refuses a plain GET that carries no Upgrade header", async () => {
    const { app } = appForUser("plain-get-user");

    const response = await app.request("/api/events");

    // 400, not 200: without this the request fell through to the SPA fallback
    // and an /api/ path answered 200 text/html.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("WebSocket upgrade");
  });

  it("does not spend a connection slot on a plain GET", async () => {
    // The connection-slot leak regression test.
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
    const { app } = appForUser("slot-leak-user");

    // Deliberately unasserted: what these requests ANSWER is the previous
    // test's subject. What matters here is only what they leave behind.
    for (let i = 0; i < MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL; i++) {
      await app.request("/api/events");
    }

    const upgraded = await app.request("/api/events", { headers: UPGRADE });

    expect(wasAccepted(upgraded)).toBe(true);
    expect(upgraded.status).not.toBe(429);
  });

  it("does not consult the auth store on a plain GET", async () => {
    // The re-validation that stops a socket outliving its credential must not
    // turn a request that never becomes a socket into an extra session lookup —
    // that would hand back the amplification the slot-leak fix removed, in a
    // different currency.
    const { app, calls } = appForUser("no-lookup-user");

    await app.request("/api/events");

    expect(calls.getSession).toBe(0);
  });

  it("still caps concurrent sockets for one principal", async () => {
    // The cap itself is unchanged; only the accounting of what counts as a
    // connection moved.
    const { app } = appForUser("capped-user");

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
    const { app } = appForUser("mixed-case-user");

    const response = await app.request("/api/events", { headers: { upgrade: "WebSocket" } });

    expect(wasAccepted(response)).toBe(true);
  });
});

/**
 * An open socket that outlives its own session.
 *
 * The route binds the subscription's user id and admin flag at upgrade and used
 * to never look again, so signing out elsewhere, an admin ban or plain expiry
 * left the stream running for a principal whose next HTTP request would have
 * been a 401.
 */
describe("/api/events revocation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes an open socket when its session is revoked, and stops sending", async () => {
    // THE FAILING ASSERTION. Against the old route nothing registered the
    // socket, so `closes` stayed empty and the event published afterwards was
    // still delivered.
    const { app } = appForUser("revoked-user");
    const socket = await openSocket(app);
    expect(socket.sent).toHaveLength(1); // the "connected" frame

    eventSocketRegistry.closeForSession("token-for-revoked-user", "session revoked");

    expect(socket.closes).toEqual([
      { code: EVENT_SOCKET_REVOKED_CLOSE_CODE, reason: "session revoked" },
    ]);

    // Closed has to mean "receives nothing". `ws.close()` is a handshake, so
    // the transport stays writable for a moment afterwards — if the event-bus
    // listener were not torn down first, this frame would still arrive.
    await publishEvent({ type: "book:updated", userId: "revoked-user" });
    expect(socket.sent).toHaveLength(1);
  });

  it("gives the connection slot back when a socket is closed by revocation", async () => {
    // Otherwise a user who is banned and later unbanned finds their budget
    // permanently spent, which is a self-inflicted denial of service.
    const { app } = appForUser("slot-return-user");
    for (let i = 0; i < MAX_EVENT_SOCKET_CONNECTIONS_PER_PRINCIPAL; i++) {
      await openSocket(app);
    }
    expect((await app.request("/api/events", { headers: UPGRADE })).status).toBe(429);

    eventSocketRegistry.closeForUser("slot-return-user", "account banned");

    expect(wasAccepted(await app.request("/api/events", { headers: UPGRADE }))).toBe(true);
  });

  it("deregisters a socket the client closed, so a later revocation is a no-op", async () => {
    const { app } = appForUser("client-closed-user");
    const socket = await openSocket(app);

    socket.handlers.onClose?.({} as CloseEvent, socket.ws);

    expect(eventSocketRegistry.closeForUser("client-closed-user", "account banned")).toBe(0);
    expect(socket.closes).toEqual([]);
  });

  describe("periodic re-validation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("closes a socket whose session has gone away without any hook firing", async () => {
      // Expiry is the case no revocation hook can see: nothing deletes an
      // expired session, and an idle socket makes no request that would make
      // Better Auth clean it up. Only the timer catches this.
      let session: unknown = {
        session: { token: "t" },
        user: { id: "expiring-user", role: "user" },
      };
      const { app } = appForUser("expiring-user", () => session);
      const socket = await openSocket(app);

      session = null;
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([
        { code: EVENT_SOCKET_REVOKED_CLOSE_CODE, reason: "session revoked" },
      ]);
    });

    it("closes a socket whose account was banned", async () => {
      // Bans are enforced on every credential path; this is the same rule
      // reaching a socket that was already open. It also covers the
      // app-password case in the general way: that credential resolves into a
      // fresh session on every check, so the ban shows up here.
      let banned = false;
      const { app } = appForUser("bannable-user", () => ({
        session: { token: "t" },
        user: { id: "bannable-user", role: "user", banned, banExpires: null },
      }));
      const socket = await openSocket(app);

      banned = true;
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([
        { code: EVENT_SOCKET_REVOKED_CLOSE_CODE, reason: "account banned" },
      ]);
    });

    it("treats an expired ban as no ban at all", async () => {
      const { app } = appForUser("unbanned-user", () => ({
        session: { token: "t" },
        user: {
          id: "unbanned-user",
          role: "user",
          banned: true,
          banExpires: new Date(Date.now() - 60_000).toISOString(),
        },
      }));
      const socket = await openSocket(app);

      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([]);
    });

    it("asks a socket to re-scope when its owner was demoted", async () => {
      // The admin flag is baked into the event-bus filter at upgrade, so an
      // ex-admin's socket would otherwise keep receiving every book event on
      // the install. It has to be closed — but as 4409, not 4401. The session
      // is untouched, and 4401 is the code that means "you are signed out": it
      // sent a demoted (or promoted) user to the login page for no reason.
      let role = "admin";
      const { app } = appForUser(
        "demoted-user",
        () => ({ session: { token: "t" }, user: { id: "demoted-user", role } }),
        "admin",
      );
      const socket = await openSocket(app);

      role = "user";
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([
        { code: EVENT_SOCKET_RESCOPE_CLOSE_CODE, reason: "role changed" },
      ]);
    });

    it("asks a socket to re-scope when it was promoted, not just demoted", async () => {
      // The check is a mismatch in either direction. Promotion is the case that
      // made this a bug worth a second code: being handed admin rights and
      // signed out for it is a strange reward.
      let role = "user";
      const { app } = appForUser("promoted-user", () => ({
        session: { token: "t" },
        user: { id: "promoted-user", role },
      }));
      const socket = await openSocket(app);

      role = "admin";
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([
        { code: EVENT_SOCKET_RESCOPE_CLOSE_CODE, reason: "role changed" },
      ]);
    });

    it("asks a socket to re-scope when its credential now resolves to somebody else", async () => {
      // Somebody signed in as another user in a second tab, so the cookie this
      // socket was upgraded with now belongs to them. The subscription is
      // scoped to the wrong person and must be closed — but signing out here
      // would end the session of the user who just signed in, which is a worse
      // outcome than the stale scope.
      let id = "shared-browser-user";
      const { app } = appForUser("shared-browser-user", () => ({
        session: { token: "t" },
        user: { id, role: "user" },
      }));
      const socket = await openSocket(app);

      id = "somebody-else";
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS);

      expect(socket.closes).toEqual([
        { code: EVENT_SOCKET_RESCOPE_CLOSE_CODE, reason: "identity changed" },
      ]);
    });

    it("keeps the two codes distinct", () => {
      // The whole contract in one line: a client that cannot tell these apart
      // has to choose between signing people out on a promotion and never
      // signing anyone out at all.
      expect(EVENT_SOCKET_RESCOPE_CLOSE_CODE).not.toBe(EVENT_SOCKET_REVOKED_CLOSE_CODE);
      // Both in the range RFC 6455 reserves for the application, so neither can
      // ever collide with a transport-level code.
      for (const code of [EVENT_SOCKET_REVOKED_CLOSE_CODE, EVENT_SOCKET_RESCOPE_CLOSE_CODE]) {
        expect(code).toBeGreaterThanOrEqual(4000);
        expect(code).toBeLessThanOrEqual(4999);
      }
    });

    it("keeps the socket open when the auth store is unreachable", async () => {
      // An infrastructure fault is not a verdict on the credential. Severing
      // every socket in the install because Redis blinked would turn a degraded
      // store into an outage.
      const { app } = appForUser("store-down-user", null);
      const socket = await openSocket(app);

      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS * 3);

      expect(socket.closes).toEqual([]);
    });

    it("stops re-validating once the client has gone", async () => {
      const { app, calls } = appForUser("gone-user");
      const socket = await openSocket(app);
      const afterUpgrade = calls.getSession;

      socket.handlers.onClose?.({} as CloseEvent, socket.ws);
      await vi.advanceTimersByTimeAsync(EVENT_SOCKET_REVALIDATE_INTERVAL_MS * 5);

      expect(calls.getSession).toBe(afterUpgrade);
    });
  });
});
