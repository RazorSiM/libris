import { computed, ref, watch, type InjectionKey } from "vue";
import type { App } from "vue";
import { storeToRefs } from "pinia";
import { useWebSocket } from "@vueuse/core";
import { useAuthStore } from "~/stores/auth";
import { reportSessionInvalidated } from "~/lib/session-invalidation";
import type { ServerEvent, EventHandler, ServerEventsApi } from "~/types/server-events";
import type { AppConfig } from "~/composables/useLibrisConfig";

export const serverEventsKey: InjectionKey<ServerEventsApi> = Symbol("libris:server-events");

/**
 * The two close codes the server uses to end a socket on purpose.
 *
 * Both mirror `services/api-hono/src/lib/event-socket-registry.ts`. Restated
 * here rather than imported: they are wire constants, and importing them would
 * drag server code into the SPA bundle for two numbers. Both sit in the
 * 4000-4999 range RFC 6455 reserves for the application, so neither can collide
 * with a transport-level code.
 *
 * They exist as a pair because the server has two different things to say, and
 * one code could only ever express one of them (libris-abt).
 */

/**
 * The credential behind this socket is gone — a ban, a sign-out from another
 * device, an admin revoking the session, plain expiry (libris-e0p).
 *
 * TERMINAL: every re-dial would be refused at the upgrade, so the only useful
 * response is to take the user to sign in.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4401;

/**
 * The credential is still good; this socket's scope is stale (libris-abt).
 *
 * The server binds a subscription's user id and admin flag at upgrade and never
 * changes them, so when the session comes back with a different role — or a
 * different person — the socket has to go, even though nothing is wrong with
 * the session. NOT terminal: reconnect and the new socket is bound to the
 * current answer.
 *
 * Sent as 4401 this was a sign-out, which for a promoted admin meant being
 * bounced to the login page as a reward for gaining rights.
 */
export const SOCKET_RESCOPE_CLOSE_CODE = 4409;

function createDisabledServerEventsApi(): ServerEventsApi {
  return {
    subscribe(_handler: EventHandler) {
      return () => {};
    },
    status: ref<"OPEN" | "CONNECTING" | "CLOSED">("CLOSED"),
    error: ref<Event | null>(null),
  };
}

function createServerEventsApi(config: AppConfig): ServerEventsApi {
  const listeners = new Set<EventHandler>();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = config.wsBaseUrl || `${protocol}//${window.location.host}`;
  const wsUrl = `${base}/api/events`;
  const error = ref<Event | null>(null);

  /**
   * Set when the server has told us THIS socket's credential is dead.
   *
   * Everything else — a dropped Wi-Fi, a server restart, a proxy idle timeout,
   * a missed heartbeat — closes with a transport-level code and must keep
   * retrying forever, because "the connection broke" is not "you are signed
   * out". Only the application-range 4401 is a verdict on the credential, and
   * it is the only thing that latches this.
   *
   * Cleared by the identity watcher below: the next identity to sign in on this
   * tab gets a socket that reconnects like any other.
   */
  let revoked = false;

  const {
    status: socketStatus,
    open,
    close,
  } = useWebSocket(wsUrl, {
    // Not on bootstrap: the socket's identity is the cookie it was upgraded
    // with, and at bootstrap nobody is signed in yet. Dialling here would
    // either open an anonymous subscription or spin a reconnect loop against a
    // 401 on /login.
    immediate: false,
    autoClose: true,
    autoReconnect: {
      // Still "forever", with one exception carved out. A predicate rather than
      // `retries: -1` because the number form has no way to say "not this one":
      // a banned user's tab re-dialled every 30s for the life of the tab, and
      // learned it was signed out only if some unrelated request happened to
      // 401.
      retries: () => !revoked,
      delay: (retries: number) => Math.min(1000 * 2 ** (retries - 1), 30000),
    },
    heartbeat: {
      message: "ping",
      pongTimeout: 5000,
    },
    onMessage(_ws: WebSocket, event: MessageEvent) {
      if (event.data === "pong") return;

      try {
        const parsed = JSON.parse(event.data) as ServerEvent;
        for (const handler of listeners) handler(parsed);
      } catch {
        // ignore malformed messages
      }
    },
    onError(_ws: WebSocket, event: Event) {
      error.value = event;
    },
    /**
     * The one place a close code is read.
     *
     * @vueuse/core calls this synchronously from `ws.onclose`, BEFORE it
     * consults `autoReconnect.retries` — so latching the flag here is seen by
     * the very retry decision it is about, with no window for one more dial.
     *
     * Reporting into reportSessionInvalidated() rather than doing anything
     * here: that is the same funnel a 401 from either HTTP transport uses, and
     * installSessionRecovery() already owns the response — logout() (which
     * clears the store and the query cache) then /login?redirect=…, once per
     * burst, and never while already on /login. A socket that grew its own
     * sign-out path would be a second answer to the same question.
     */
    onDisconnected(_ws: WebSocket, event: CloseEvent) {
      // Spelled out rather than left to fall through the check below: the two
      // application codes are one contract, and reading only half of it — "any
      // 4xxx means signed out" — is exactly how a promotion became a sign-out.
      // A re-scope is an ordinary reconnect; the server rebinds on the way in.
      if (event.code === SOCKET_RESCOPE_CLOSE_CODE) return;
      if (event.code !== SESSION_REVOKED_CLOSE_CODE) return;
      revoked = true;
      reportSessionInvalidated();
    },
  });

  /**
   * One socket per identity, not one per tab.
   *
   * The server binds the subscription's user id and admin flag AT UPGRADE TIME
   * (routes/api/events.ts) and never re-checks them, so a socket that outlives
   * the session it was authenticated with is a subscription in somebody else's
   * name. Sign-out and sign-in are both SPA navigations — no page load resets
   * anything — so an admin signing out and a regular user signing in on the
   * same tab would leave the second user holding the first user's admin-scoped
   * feed: every book event on the install, and none of their own.
   *
   * Keyed on the store's userId rather than driven from login()/logout() so
   * that any route to a new identity re-dials, including ones that never went
   * through login() at all.
   */
  const { userId } = storeToRefs(useAuthStore());

  watch(
    userId,
    (id) => {
      close();
      error.value = null;
      // A new identity is a new credential: whatever killed the last socket is
      // not this one's problem. Safe to clear here — Vue flushes watchers in a
      // microtask, long after the synchronous retry decision that reads it.
      revoked = false;
      if (id) open();
    },
    { immediate: true },
  );

  // useWebSocket leaves `status` on its last value after an explicit close (it
  // clears its own socket ref before the close event lands, so its handler
  // skips the update). Signed out means closed, whatever it says.
  const status = computed(() => (userId.value ? socketStatus.value : "CLOSED"));

  return {
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    status,
    error,
  };
}

export function setupServerEvents(app: App, config: AppConfig) {
  const globalWindow = window as Window & {
    __LIBRIS_DISABLE_SERVER_EVENTS__?: boolean;
  };

  const api = globalWindow.__LIBRIS_DISABLE_SERVER_EVENTS__
    ? createDisabledServerEventsApi()
    : createServerEventsApi(config);

  app.provide(serverEventsKey, api);
}
