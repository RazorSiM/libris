import { computed, ref, watch, type InjectionKey } from "vue";
import type { App } from "vue";
import { storeToRefs } from "pinia";
import { useWebSocket } from "@vueuse/core";
import { useAuthStore } from "~/stores/auth";
import { reportSessionInvalidated } from "~/lib/session-invalidation";
import { reportSessionRescoped } from "~/lib/session-rescope";
import { isRotatingSession, sessionRotationSettled } from "~/lib/session-rotation";
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
 * one code could only ever express one of them.
 */

/**
 * The credential behind this socket is gone — a ban, a sign-out from another
 * device, an admin revoking the session, plain expiry.
 *
 * TERMINAL: every re-dial would be refused at the upgrade, so the only useful
 * response is to take the user to sign in.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4401;

/**
 * The credential is still good; this socket's scope is stale.
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
   * A 4401 is latched here BEFORE it is interpreted, because @vueuse/core reads
   * the retries predicate on the next line of its own onclose and there is no
   * later moment at which the dial can be claimed. The one interpretation that
   * releases it again is a rotation this tab asked for — see
   * resolveOwnRotation().
   *
   * Cleared by the identity watcher below: the next identity to sign in on this
   * tab gets a socket that reconnects like any other.
   */
  let revoked = false;

  /**
   * Set between a 4409 — or a 4401 this tab's own rotation caused — and the
   * refreshed session that answers it.
   *
   * While it is set, @vueuse/core's own reconnect is switched off and THIS
   * module owns the re-dial. That is the whole double-dial fix, and it is not
   * an optimisation: the two dialers would race.
   *
   * @vueuse/core schedules its retry from `ws.onclose` — synchronously, before
   * anything here can await a session. A re-scope that turns out to be an
   * IDENTITY change also moves the store's userId, and the identity watcher
   * below answers that with close() + open(). `close()` sets useWebSocket's
   * `explicitlyClosed`, which would make the pending retry a no-op — but
   * `open()` clears it again, so a retry timer that fires after the watcher
   * builds a SECOND socket and orphans the first, which stays open on the
   * server until it notices. Two live sockets for one principal is exactly what
   * eventSocketConnectionGuard caps, so the third re-scope in a session would
   * be refused with a 429 rather than reconnecting.
   *
   * Taking the dial rather than trying to cancel theirs is also the more
   * correct reading: a re-scope's whole point is that the NEXT socket must be
   * upgraded with the new scope, so it should not be dialled before the app
   * knows what that scope is — and if the refresh finds no session, it should
   * not be dialled at all.
   */
  let rescoping = false;

  /**
   * The identity this tab's socket belongs to.
   *
   * Read in two places: the watcher at the bottom, which re-keys the socket
   * when it changes, and the re-scope handler, which has to tell an identity
   * change (the watcher's dial) from a role change (its own).
   */
  const { userId } = storeToRefs(useAuthStore());

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
      // Still "forever", with two exceptions carved out. A predicate rather
      // than `retries: -1` because the number form has no way to say "not this
      // one": a banned user's tab re-dialled every 30s for the life of the tab,
      // and learned it was signed out only if some unrelated request happened
      // to 401. `rescoping` is the second exception — that dial is ours, see
      // the flag's declaration.
      retries: () => !revoked && !rescoping,
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
      if (event.code === SOCKET_RESCOPE_CLOSE_CODE) {
        // One resolution at a time. A second 4409 landing before the first is
        // answered is covered by the dial the first will make, and starting
        // another would produce the extra socket by a different route.
        if (rescoping) return;
        // Set BEFORE anything async: @vueuse/core reads the retries predicate
        // on the next line of its own onclose, so this is the only moment at
        // which the dial can be claimed.
        rescoping = true;
        void resyncThenRedial();
        return;
      }
      if (event.code !== SESSION_REVOKED_CLOSE_CODE) return;
      // Latched first either way: whichever branch runs, @vueuse/core must not
      // schedule a dial of its own from the next line of its onclose. The
      // rotation branch clears it again once it knows what it is dialling with.
      revoked = true;

      // The one 4401 that is not a revocation: this tab is in the middle of
      // replacing its own credential, and the row the server just deleted is
      // the one it is replacing (~/lib/session-rotation). Deciding here would
      // sign the user out of the browser they changed their password in.
      if (isRotatingSession()) {
        // Same one-at-a-time rule as the re-scope path, and the same flag,
        // because from here on this IS the re-scope path.
        if (rescoping) return;
        rescoping = true;
        void resolveOwnRotation();
        return;
      }

      reportSessionInvalidated();
    },
  });

  /**
   * Answer a 4401 that landed while this tab was rotating its own credential.
   *
   * Waiting on the rotation rather than probing the session: the close frame is
   * written before the response that carries the new cookie, so a probe fired
   * from the close handler would ask with the dead cookie and be told, quite
   * correctly, that there is no session. The rotation's own promise is the only
   * thing that resolves after the browser has applied the replacement.
   *
   * If the rotation FAILED there is no new cookie, so the 4401 stands and goes
   * down the ordinary sign-out path with the store untouched — which matters,
   * because installSessionRecovery() declines to act for someone it already
   * believes is signed out.
   */
  async function resolveOwnRotation(): Promise<void> {
    const rotated = await sessionRotationSettled();
    if (!rotated) {
      rescoping = false;
      reportSessionInvalidated();
      return;
    }

    // The credential this tab holds is the NEW one. Nothing about it is
    // revoked, and leaving the latch set would suppress the reconnect for an
    // ordinary dropped connection on every socket after this.
    revoked = false;
    // From here it is exactly a re-scope: catch the store up with the session
    // the server re-issued, then dial once — or not at all, if the refresh
    // finds nobody. resyncThenRedial() owns clearing `rescoping`.
    await resyncThenRedial();
  }

  /**
   * Catch the app up with the session the server just re-scoped against, then
   * re-dial — but only if nobody else is going to.
   *
   * The server rebinds scope at upgrade, so the socket alone was already
   * correct after a 4409. The store was not, and it is what renders: the
   * sidebar's admin navigation, and the name in the chrome.
   *
   * Exactly one dial happens per re-scope, and which code performs it depends
   * on what the refresh found:
   *
   *  - the identity changed — the store's userId moved, so the watcher below
   *    is already closing and re-opening. Dialling here too is the double-dial.
   *  - the role changed, or nothing the store can see did — the userId is
   *    unchanged, no watcher fires, and this is the only thing left to dial.
   *  - there is no session any more — the refresh found nobody. Do not dial;
   *    the identity watcher has already closed the socket, and the guard sends
   *    the user to sign in on their next navigation.
   *  - a 4401 arrived while the refresh was in flight — that is terminal and
   *    outranks a re-scope, so leave the socket down.
   */
  async function resyncThenRedial(): Promise<void> {
    const before = userId.value;
    try {
      await reportSessionRescoped();
    } finally {
      // Cleared unconditionally: leaving it set would suppress the reconnect
      // for an ordinary dropped connection on the next socket.
      rescoping = false;
    }

    if (revoked) return;
    if (!userId.value) return;
    if (userId.value !== before) return;
    open();
  }

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
  watch(
    userId,
    (id) => {
      close();
      error.value = null;
      // A new identity is a new credential: whatever killed the last socket is
      // not this one's problem. Safe to clear here — Vue flushes watchers in a
      // microtask, long after the synchronous retry decision that reads it.
      revoked = false;
      // Handing the dial back to @vueuse/core as well. This watcher IS the
      // re-scope's dial when the identity moved, so an in-flight
      // resyncThenRedial() is done deciding; leaving the flag set would mean a
      // socket that dropped for an ordinary transport reason before that
      // decision landed never retried.
      rescoping = false;
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
