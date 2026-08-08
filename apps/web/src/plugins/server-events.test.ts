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
  onMessage: (ws: unknown, event: { data: string }) => void;
}

const open = vi.fn();
const close = vi.fn();
const status = shallowRef("CLOSED");
const useWebSocket = vi.fn((_url: string, _options: SocketOptions) => ({ status, open, close }));

vi.mock("@vueuse/core", () => ({
  useWebSocket: (url: string, options: SocketOptions) => useWebSocket(url, options),
}));

const { setupServerEvents, serverEventsKey } = await import("./server-events");
const { useAuthStore } = await import("~/stores/auth");

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

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  status.value = "CLOSED";
  setDisabled(false);
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
