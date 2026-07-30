import { inject, onScopeDispose } from "vue";
import { serverEventsKey } from "~/plugins/server-events";
import type { EventHandler } from "~/types/server-events";

export type { EventHandler, ServerEvent } from "~/types/server-events";

/**
 * Composable that streams real-time events from the backend via WebSocket.
 * All callers share a single WebSocket connection; bookId filtering is
 * applied client-side per composable instance.
 *
 * Usage:
 *   const { on, close } = useServerEvents()
 *   on('book:metadata-ready', (event) => { ... })
 *
 * With book filter:
 *   const { on, close } = useServerEvents({ bookId: '123' })
 */
export function useServerEvents(opts?: { bookId?: string }) {
  const injected = inject(serverEventsKey);
  if (!injected) {
    throw new Error("useServerEvents() called before setupServerEvents() ran in main.ts");
  }
  const bus = injected;
  const unsubs: (() => void)[] = [];

  onScopeDispose(() => {
    close();
  });

  function on(type: string, handler: EventHandler): () => void {
    const wrapped: EventHandler = (event) => {
      if (opts?.bookId && event.bookId && event.bookId !== opts.bookId) return;
      if (type !== "*" && event.type !== type) return;
      handler(event);
    };

    const unsub = bus.subscribe(wrapped);
    unsubs.push(unsub);
    return () => {
      unsub();
      const idx = unsubs.indexOf(unsub);
      if (idx !== -1) unsubs.splice(idx, 1);
    };
  }

  function close() {
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
  }

  return {
    on,
    close,
    status: bus.status,
    error: bus.error,
  };
}
