import { computed, ref, watch, type InjectionKey } from "vue";
import type { App } from "vue";
import { storeToRefs } from "pinia";
import { useWebSocket } from "@vueuse/core";
import { useAuthStore } from "~/stores/auth";
import type { ServerEvent, EventHandler, ServerEventsApi } from "~/types/server-events";
import type { AppConfig } from "~/composables/useLibrisConfig";

export const serverEventsKey: InjectionKey<ServerEventsApi> = Symbol("libris:server-events");

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
      retries: -1,
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
