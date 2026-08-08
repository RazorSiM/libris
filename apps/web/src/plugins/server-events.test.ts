// @vitest-environment happy-dom
/**
 * The realtime socket's identity (libris-59m.27).
 *
 * The server binds a subscription's user id and admin flag at UPGRADE time and
 * never re-checks them, so the socket IS an identity. Sign-out and sign-in are
 * both SPA navigations — nothing reloads the page — which is how an admin's
 * admin-scoped feed survived into the next person's session on a shared
 * browser: they received every book event on the install, and none of their
 * own.
 *
 * These pin the connect/disconnect decisions rather than the transport, which
 * is @vueuse/core's problem.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { nextTick, shallowRef } from "vue";
import type { ServerEventsApi } from "~/types/server-events";

interface SocketOptions {
  immediate?: boolean;
  autoReconnect?: {
    retries?: number | ((retried: number) => boolean);
    delay?: number | ((retries: number) => number);
  };
  onMessage: (ws: unknown, event: { data: string }) => void;
  onDisconnected?: (ws: unknown, event: { code: number; reason: string }) => void;
}

const open = vi.fn();
const close = vi.fn();
const status = shallowRef("CLOSED");
const useWebSocket = vi.fn((_url: string, _options: SocketOptions) => ({ status, open, close }));

vi.mock("@vueuse/core", () => ({
  useWebSocket: (url: string, options: SocketOptions) => useWebSocket(url, options),
}));

const {
  setupServerEvents,
  serverEventsKey,
  SESSION_REVOKED_CLOSE_CODE,
  SOCKET_RESCOPE_CLOSE_CODE,
} = await import("./server-events");
const { useAuthStore } = await import("~/stores/auth");
const { setSessionRecovery } = await import("~/lib/session-invalidation");
const { setSessionRescope } = await import("~/lib/session-rescope");

/** Run setupServerEvents and hand back whatever it provided. */
function mount(): ServerEventsApi {
  const provided = new Map<unknown, unknown>();
  setupServerEvents(
    { provide: (key: unknown, value: unknown) => provided.set(key, value) } as never,
    { wsBaseUrl: "ws://api.test", docsUrl: "" },
  );
  return provided.get(serverEventsKey) as ServerEventsApi;
}

/** The options the plugin handed useWebSocket. */
function socketOptions(): SocketOptions {
  const call = useWebSocket.mock.calls[0];
  if (!call) throw new Error("useWebSocket was never called");
  return call[1];
}

function setDisabled(value: boolean) {
  (
    window as Window & { __LIBRIS_DISABLE_SERVER_EVENTS__?: boolean }
  ).__LIBRIS_DISABLE_SERVER_EVENTS__ = value;
}

/**
 * Deliver a close event the way @vueuse/core does — synchronously, from
 * `ws.onclose`, before it decides whether to re-dial.
 */
function disconnect(code: number, reason = "") {
  const handler = socketOptions().onDisconnected;
  if (!handler) {
    throw new Error("the plugin registered no onDisconnected handler; it cannot see close codes");
  }
  handler(null, { code, reason });
}

/**
 * Whether @vueuse/core would schedule another dial after that close, resolved
 * exactly as useWebSocket resolves it internally.
 */
function willReconnect(retried = 1): boolean {
  const retries = socketOptions().autoReconnect?.retries;
  if (typeof retries === "function") return retries(retried);
  // The plain-number form. -1 means "forever, whatever happened" — which is the
  // bug: it cannot tell a revoked credential from a dropped Wi-Fi.
  return typeof retries === "number" && (retries < 0 || retried < retries);
}

/** reportSessionInvalidated() is fire-and-forget; let its promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  status.value = "CLOSED";
  setDisabled(false);
  setSessionRecovery(null);
  setSessionRescope(null);
});

describe("the socket's identity", () => {
  it("opens nothing while nobody is signed in", async () => {
    // /login has nothing to subscribe to, and dialling there is a reconnect
    // loop against a 401 at best.
    mount();
    await nextTick();

    expect(useWebSocket).toHaveBeenCalledTimes(1);
    expect(socketOptions().immediate).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("dials once the session resolves", async () => {
    mount();
    const store = useAuthStore();

    store.userId = "alice";
    await nextTick();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes on sign-out", async () => {
    mount();
    const store = useAuthStore();
    store.userId = "alice";
    await nextTick();
    close.mockClear();

    store.userId = null;
    await nextTick();

    expect(close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("re-dials when a different user signs in on the same tab", async () => {
    // THE FAILURE: admin Alice signs out, Bob signs in, and without this the
    // socket is still Alice's admin-scoped subscription. Bob sees everybody's
    // events and none of his own.
    mount();
    const store = useAuthStore();

    store.userId = "alice";
    await nextTick();
    store.userId = null;
    await nextTick();
    store.userId = "bob";
    await nextTick();

    expect(close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("re-dials on a session swap that never passed through sign-out", async () => {
    // Keyed on the identity rather than driven from login()/logout(), so a
    // swap by any other route re-dials too.
    mount();
    const store = useAuthStore();

    store.userId = "alice";
    await nextTick();
    store.userId = "bob";
    await nextTick();

    expect(open).toHaveBeenCalledTimes(2);
    // Once on mount (signed out), then once per identity change.
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("reports CLOSED while signed out, whatever the transport last said", async () => {
    // useWebSocket clears its own socket ref before the close event lands, so
    // its status is left on OPEN after an explicit close. A status that says
    // OPEN with no socket is worse than no status.
    const api = mount();
    const store = useAuthStore();

    store.userId = "alice";
    await nextTick();
    status.value = "OPEN";
    expect(api.status.value).toBe("OPEN");

    store.userId = null;
    await nextTick();
    expect(api.status.value).toBe("CLOSED");
  });

  it("keeps subscribers across a re-dial", async () => {
    // Components subscribe once, on mount. If a re-dial dropped the listener
    // set, the new session would have a live socket and a dead bus.
    const api = mount();
    const store = useAuthStore();
    const received: unknown[] = [];
    api.subscribe((event) => received.push(event));

    store.userId = "alice";
    await nextTick();
    store.userId = "bob";
    await nextTick();

    socketOptions().onMessage(null, { data: JSON.stringify({ type: "book:detected" }) });

    expect(received).toEqual([{ type: "book:detected" }]);
  });
});

/**
 * A revoked socket is terminal; a broken or re-scoped one is not (libris-abt).
 *
 * The server closes an event socket with 4401 when the credential behind it
 * stops being valid — banned, revoked from another device, expired. The client
 * treated that as any other drop and re-dialled forever behind a 30s backoff,
 * so a banned user watched a page that quietly stopped updating and was told
 * nothing, while the server took an attempt every 30s per abandoned tab.
 *
 * Both other directions are worse than the bug. Latching on a transport-level
 * close would sign people out over a flaky connection; latching on the whole
 * 4xxx range would sign them out on a promotion, since the server also closes a
 * socket whose scope went stale (4409) while the session behind it is fine.
 * All three cases are pinned here.
 */
describe("a socket the server refuses", () => {
  /** Mount with a signed-in identity and a recovery installed. */
  async function signedIn() {
    const recovery = vi.fn(async () => {});
    setSessionRecovery(recovery);
    mount();
    const store = useAuthStore();
    store.userId = "alice";
    await nextTick();
    return { recovery, store };
  }

  it("stops re-dialling once the server says the credential is gone", async () => {
    // THE FAILURE: `retries: -1` has no way to say "not this one", so the tab
    // of a user who was just banned kept dialling for as long as it stayed open.
    await signedIn();

    disconnect(SESSION_REVOKED_CLOSE_CODE, "account banned");

    expect(willReconnect()).toBe(false);
  });

  it("routes a revoked socket into the app's one sign-out path", async () => {
    // Not its own logout: reportSessionInvalidated() is where both HTTP
    // transports report a 401, and installSessionRecovery() already knows to
    // logout() and redirect once per burst.
    const { recovery } = await signedIn();

    disconnect(SESSION_REVOKED_CLOSE_CODE, "session revoked");
    await settle();

    expect(recovery).toHaveBeenCalledTimes(1);
  });

  // Everything a network does on a bad day. None of it is a verdict on the
  // session, and reacting to any of it would sign users out over a dropped
  // connection — including 4000, which is in the same application range as 4401
  // and still not it.
  it.each([
    [1000, "a clean close, which is what a missed heartbeat looks like"],
    [1001, "the server going away for a restart"],
    [1006, "the connection dropping with no close frame at all"],
    [1011, "an unexpected server-side condition"],
    [1012, "a proxy or server restarting"],
    [4000, "some other application code that is not 4401"],
  ])("keeps re-dialling after close code %i (%s)", async (code) => {
    const { recovery } = await signedIn();

    disconnect(code);
    await settle();

    expect(willReconnect(1)).toBe(true);
    // Still trying an hour later: retries is unbounded for a transport fault.
    expect(willReconnect(500)).toBe(true);
    expect(recovery).not.toHaveBeenCalled();
  });

  it("re-dials, and stays signed in, when the server only wants a re-scope", async () => {
    // A promotion or a demotion closes the socket because the admin flag is
    // baked in at upgrade — but the session is untouched. Under one close code
    // this was indistinguishable from a ban, so being made an admin signed you
    // out. The pairing of the two codes is the fix, so the value is pinned here
    // as well as the behaviour: they are a wire contract with the server, and
    // agreeing on 4409 is half of it.
    expect(SOCKET_RESCOPE_CLOSE_CODE).toBe(4409);
    expect(SESSION_REVOKED_CLOSE_CODE).toBe(4401);
    const { recovery } = await signedIn();
    open.mockClear();

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");
    await settle();

    expect(open).toHaveBeenCalledTimes(1);
    expect(recovery).not.toHaveBeenCalled();
  });

  it("still signs out on a revocation that follows a re-scope", async () => {
    // The re-scope must not leave anything latched that would swallow a real
    // revocation arriving on the next socket.
    const { recovery } = await signedIn();
    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");

    disconnect(SESSION_REVOKED_CLOSE_CODE, "account banned");
    await settle();

    expect(willReconnect()).toBe(false);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("re-dials normally for the next identity on the tab", async () => {
    // The revocation belonged to Alice's credential. Bob signs in on the same
    // tab afterwards and gets a socket that reconnects like any other.
    const { store } = await signedIn();
    disconnect(SESSION_REVOKED_CLOSE_CODE, "account banned");

    store.userId = null;
    await nextTick();
    store.userId = "bob";
    await nextTick();

    expect(open).toHaveBeenCalledTimes(2);
    expect(willReconnect()).toBe(true);
  });

  it("does not report a plain sign-out as a dead session", async () => {
    // Signing out closes the socket through the identity watcher, and the
    // transport reports that as an ordinary 1000. Reporting it would mean
    // every sign-out ran the recovery on the way out.
    const { recovery, store } = await signedIn();

    store.userId = null;
    await nextTick();
    disconnect(1000);
    await settle();

    expect(close).toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
  });
});

/**
 * A re-scope has to catch the STORE up too, and dial exactly once (libris-cxy).
 *
 * libris-abt stopped a 4409 from signing the user out, and the socket that came
 * back was correctly scoped — the server reads the current session at upgrade.
 * Nothing refreshed the SPA, though, and check() short-circuits on `checked`
 * for the rest of the page's life, so a promoted user got an admin-scoped feed
 * behind a sidebar with no admin navigation, and an identity change left the
 * chrome naming the previous user until the tab was reloaded.
 *
 * Adding the refresh introduces the race these tests exist for. @vueuse/core
 * schedules its own retry synchronously from `ws.onclose`, before any session
 * request can answer; if the refresh then moves the identity, the watcher
 * dials as well, and `open()` clears the `explicitlyClosed` flag that would
 * otherwise have neutered the pending timer. Two sockets for one principal is
 * what the server's per-principal cap refuses.
 */
describe("a socket the server re-scopes", () => {
  /** Mount signed in as Alice, with a recovery installed and `open` reset. */
  async function signedInAsAlice() {
    const recovery = vi.fn(async () => {});
    setSessionRecovery(recovery);
    mount();
    const store = useAuthStore();
    store.userId = "alice";
    store.admin = false;
    await nextTick();
    open.mockClear();
    close.mockClear();
    return { recovery, store };
  }

  it("refreshes the session behind a promotion", async () => {
    // THE FAILURE: the socket rebound as an admin and the sidebar did not.
    // The handler stands in for useAuth().refresh(); what is pinned here is
    // that the plugin asks for one at all, and waits for it.
    const { store, recovery } = await signedInAsAlice();
    setSessionRescope(async () => {
      store.admin = true;
    });

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");
    await settle();

    expect(store.admin).toBe(true);
    expect(recovery).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("dials once, after the refresh, instead of racing the transport's retry", async () => {
    // THE DOUBLE-DIAL: @vueuse/core's retry and the plugin's own open() are two
    // dialers for one close. The predicate has to hand the dial over for
    // exactly this close, and hand it back afterwards.
    const { store } = await signedInAsAlice();
    let refreshed: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      refreshed = resolve;
    });
    setSessionRescope(() => pending);

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");

    // Nothing may be scheduled behind our back while the session is unknown.
    expect(willReconnect()).toBe(false);
    expect(open).not.toHaveBeenCalled();

    store.admin = true;
    refreshed();
    await settle();

    expect(open).toHaveBeenCalledTimes(1);
    // ...and the next close is an ordinary drop again, retried by the transport.
    expect(willReconnect()).toBe(true);
  });

  it("leaves the dial to the identity watcher when the person changed", async () => {
    // The other half of the double-dial: the refresh moves userId, the watcher
    // closes and re-opens, and a second open() here would be the extra socket.
    const { store } = await signedInAsAlice();
    setSessionRescope(async () => {
      store.userId = "bob";
    });

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "identity changed");
    await settle();

    expect(store.userId).toBe("bob");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not dial when the refresh finds no session at all", async () => {
    // A re-scope is not a revocation, but the refresh answering "nobody" is.
    // Dialling anyway would be a reconnect loop against a 401.
    const { store } = await signedInAsAlice();
    setSessionRescope(async () => {
      store.userId = null;
    });

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "identity changed");
    await settle();

    expect(open).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("does not dial when a revocation overtakes the refresh", async () => {
    // 4401 is terminal and outranks a re-scope still waiting on its session.
    const { recovery } = await signedInAsAlice();
    let refreshed: () => void = () => {};
    setSessionRescope(
      () =>
        new Promise<void>((resolve) => {
          refreshed = resolve;
        }),
    );

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");
    disconnect(SESSION_REVOKED_CLOSE_CODE, "account banned");
    refreshed();
    await settle();

    expect(open).not.toHaveBeenCalled();
    expect(willReconnect()).toBe(false);
    expect(recovery).toHaveBeenCalledTimes(1);
  });

  it("asks for one refresh however many closes arrive together", async () => {
    // Two tabs' worth of sockets, or a re-scope that races a reconnect, must
    // not turn into a session request per close.
    const refresh = vi.fn(async () => {});
    await signedInAsAlice();
    setSessionRescope(refresh);

    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");
    disconnect(SOCKET_RESCOPE_CLOSE_CODE, "role changed");
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("the disabled bus", () => {
  it("opens no socket at all when events are switched off", async () => {
    // The E2E fixtures set this so networkidle-based specs can settle.
    setDisabled(true);
    mount();
    const store = useAuthStore();
    store.userId = "alice";
    await nextTick();

    expect(useWebSocket).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
