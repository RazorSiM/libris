import { ref, type InjectionKey } from "vue";
import type { App } from "vue";
import { useWebSocket } from "@vueuse/core";
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

  const { status } = useWebSocket(wsUrl, {
    immediate: true,
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
