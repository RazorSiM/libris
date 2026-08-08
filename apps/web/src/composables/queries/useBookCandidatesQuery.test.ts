// @vitest-environment happy-dom
/**
 * Book metadata candidates, through a REAL Pinia Colada query and a REAL
 * useApiClient(). Only the network is replaced.
 *
 * This one is event-triggered rather than key-driven: `RefetchMetadataModal`
 * asks for it when the pipeline announces `book:metadata-ready`, never on
 * mount. That is why the query is permanently disabled and driven by
 * `refetch()`. The point of routing it through Colada anyway is that the
 * answer lands in the query cache under the book's own key, so the
 * `invalidateQueries({ key: ["library", id] })` every book mutation already
 * issues reaches it — a component-local ref could not be reached at all.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { computed, defineComponent, h, ref, watch } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { PiniaColada, useQueryCache } from "@pinia/colada";

const apiClient = await import("~/composables/useApiClient");

Object.assign(globalThis, {
  ref,
  computed,
  watch,
  toValue: (v: unknown) => (typeof v === "function" ? (v as () => unknown)() : v),
  useApiClient: apiClient.useApiClient,
});

const { useBookCandidatesQuery } = await import("./useBookDetailQuery");

const BOOK_ID = "11111111-1111-4111-8111-111111111111";

const RESPONSE = {
  book: { id: BOOK_ID, status: "organized", title: "Dune", author: "Frank Herbert" },
  candidates: [
    { id: "c1", source: "file", normalized: {}, confidence: "0.5", selectedFields: [] },
    { id: "c2", source: "hardcover", normalized: {}, confidence: "0.9", selectedFields: [] },
  ],
};

/**
 * The URL a `fetch` spy was actually called with.
 *
 * The client may express a request as a string, a `URL` or a `Request`, so
 * `String(input)` would quietly produce "[object Object]" for the last of
 * those and the assertion would pass on nothing.
 */
function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mountCandidates() {
  let api!: ReturnType<typeof useBookCandidatesQuery>;
  let cache!: ReturnType<typeof useQueryCache>;
  mount(
    defineComponent({
      setup() {
        api = useBookCandidatesQuery(() => BOOK_ID);
        cache = useQueryCache();
        return () => h("div");
      },
    }),
    { global: { plugins: [createPinia(), PiniaColada] } },
  );
  return { api, cache };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("useBookCandidatesQuery()", () => {
  it("issues nothing on mount — the pipeline decides when there is anything to read", async () => {
    const fetchMock = respondWith(200, RESPONSE);
    mountCandidates();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches on refetch() and resolves with the candidates", async () => {
    const fetchMock = respondWith(200, RESPONSE);
    const { api } = mountCandidates();

    const state = await api.refetch();

    expect(state.status).toBe("success");
    expect(state.data?.candidates).toHaveLength(2);
    expect(requestedUrl(fetchMock.mock.calls[0]![0])).toContain(`/api/books/${BOOK_ID}/candidates`);
  });

  it("stores the answer in the query cache under the book's key", async () => {
    // This is what the component-local ref could never do: the entry is
    // reachable by the ["library", id] prefix every book mutation invalidates.
    respondWith(200, RESPONSE);
    const { api, cache } = mountCandidates();

    await api.refetch();

    const entries = cache.getEntries({ key: ["library", BOOK_ID] });
    expect(entries.map((e) => e.key)).toContainEqual(["library", BOOK_ID, "candidates"]);
    expect(entries.some((e) => e.stale)).toBe(false);

    await cache.invalidateQueries({ key: ["library", BOOK_ID] });
    expect(entries.every((e) => e.stale)).toBe(true);
  });

  it("resolves with an error state rather than rejecting when the book is gone", async () => {
    // The modal reads the returned state to pick its phase; a rejection here
    // would escape the WebSocket handler as an unhandled rejection instead.
    respondWith(404, { error: "Book not found" });
    const { api } = mountCandidates();

    const state = await api.refetch();

    expect(state.status).toBe("error");
    expect(state.error).toBeInstanceOf(Error);
  });
});
