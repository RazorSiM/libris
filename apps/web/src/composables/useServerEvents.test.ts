// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import { serverEventsKey } from "~/plugins/server-events";
import type { EventHandler, ServerEvent } from "~/types/server-events";
import { useServerEvents } from "./useServerEvents";

function event(bookId: string | undefined, type = "book:metadata-ready"): ServerEvent {
  return { type, bookId, timestamp: new Date().toISOString() };
}

function createBus() {
  const handlers = new Set<EventHandler>();
  return {
    emit(serverEvent: ServerEvent) {
      for (const handler of handlers) handler(serverEvent);
    },
    api: {
      subscribe: (handler: EventHandler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      status: ref("open"),
      error: ref<Event | null>(null),
    },
  };
}

function mountWithBus(setup: () => void, bus: ReturnType<typeof createBus>) {
  const component = defineComponent({
    setup() {
      setup();
      return () => h("div");
    },
  });
  return mount(component, {
    global: { provide: { [serverEventsKey]: bus.api } },
  });
}

describe("useServerEvents book filter", () => {
  it("filters on the value at delivery time, not at subscribe time", () => {
    const bus = createBus();
    const currentBook = ref("book-a");
    const received: string[] = [];

    mountWithBus(() => {
      const { on } = useServerEvents({ bookId: currentBook });
      on("book:metadata-ready", (e) => received.push(e.bookId ?? "none"));
    }, bus);

    bus.emit(event("book-a"));
    bus.emit(event("book-b"));
    expect(received).toEqual(["book-a"]);

    // The page was reused for another route parameter: the same subscription
    // must now accept B and ignore A.
    currentBook.value = "book-b";
    bus.emit(event("book-a"));
    bus.emit(event("book-b"));
    expect(received).toEqual(["book-a", "book-b"]);
  });

  it("accepts a plain string for backward compatibility", () => {
    const bus = createBus();
    const received: string[] = [];
    mountWithBus(() => {
      const { on } = useServerEvents({ bookId: "book-a" });
      on("book:metadata-ready", (e) => received.push(e.bookId ?? "none"));
    }, bus);

    bus.emit(event("book-b"));
    bus.emit(event("book-a"));
    expect(received).toEqual(["book-a"]);
  });

  it("still filters by event type", () => {
    const bus = createBus();
    const handler = vi.fn();
    mountWithBus(() => {
      const { on } = useServerEvents({ bookId: "book-a" });
      on("book:organized", handler);
    }, bus);

    bus.emit(event("book-a", "book:metadata-ready"));
    bus.emit(event("book-a", "book:organized"));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
