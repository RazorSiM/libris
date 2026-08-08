// @vitest-environment happy-dom
/**
 * Command-palette suggestions, through a REAL Pinia Colada query and a REAL
 * useApiClient(). Only the network is replaced.
 *
 * The palette used to swallow every failure in a bare `catch` and show an
 * empty book group. That visible behaviour is deliberately unchanged — an
 * error banner inside a command palette is worse than no books — but the
 * failure is now readable on the composable instead of being discarded, and
 * the spinner has to stop either way.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { computed, defineComponent, h, nextTick, ref, watch } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { PiniaColada } from "@pinia/colada";

const apiClient = await import("~/composables/useApiClient");
const debounced = await import("~/composables/useDebouncedSearch");

const isAuthenticated = ref(true);

// What the auto-import plugin normally injects into composable scope.
Object.assign(globalThis, {
  ref,
  computed,
  watch,
  useApiClient: apiClient.useApiClient,
  useDebouncedSearch: debounced.useDebouncedSearch,
  useAuth: () => ({ isAuthenticated }),
});

const { useSearchSuggestQuery } = await import("./useSearchSuggestQuery");

type Suggest = ReturnType<typeof useSearchSuggestQuery>;

const BOOK = {
  id: "b1",
  title: "The Alice Chronicles",
  author: "Lewis Carroll",
  status: "organized",
  coverUrl: null,
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

function mountSuggest() {
  let api!: Suggest;
  mount(
    defineComponent({
      setup() {
        api = useSearchSuggestQuery();
        return () => h("div");
      },
    }),
    { global: { plugins: [createPinia(), PiniaColada] } },
  );
  return api;
}

/** Let the 200ms debounce fire and the request resolve. */
async function settle() {
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  isAuthenticated.value = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSearchSuggestQuery()", () => {
  it("returns the matching books for the typed term", async () => {
    const fetchMock = respondWith(200, { data: [BOOK] });
    const api = mountSuggest();

    api.term.value = "alice";
    await settle();

    expect(api.results.value).toEqual([BOOK]);
    expect(api.loading.value).toBe(false);
    expect(requestedUrl(fetchMock.mock.calls[0]![0])).toContain("q=alice");
  });

  it("shows no books and no spinner when the request fails, but exposes the error", async () => {
    respondWith(500, { error: "search index unavailable" });
    const api = mountSuggest();

    api.term.value = "alice";
    await settle();

    // Unchanged on screen: the palette keeps its navigation links and lists
    // no books. Changed underneath: the failure is no longer discarded.
    expect(api.results.value).toEqual([]);
    expect(api.loading.value).toBe(false);
    expect(api.error.value).toBeInstanceOf(Error);
    expect(api.error.value?.message).toContain("search index unavailable");
  });

  it("spends no request on an empty term", async () => {
    const fetchMock = respondWith(200, { data: [BOOK] });
    const api = mountSuggest();

    api.term.value = "   ";
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.results.value).toEqual([]);
    expect(api.loading.value).toBe(false);
  });

  it("reports loading from the keystroke, before the debounce releases it", async () => {
    respondWith(200, { data: [BOOK] });
    const api = mountSuggest();

    api.term.value = "alice";
    await nextTick();
    expect(api.loading.value).toBe(true);

    await settle();
    expect(api.loading.value).toBe(false);
  });

  it("serves a repeated term from the cache instead of re-requesting", async () => {
    // The palette is opened and closed constantly; the hand-rolled version hit
    // the API on every debounce fire.
    const fetchMock = respondWith(200, { data: [BOOK] });
    const api = mountSuggest();

    api.term.value = "alice";
    await settle();
    api.term.value = "bob";
    await settle();
    api.term.value = "alice";
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.results.value).toEqual([BOOK]);
  });

  it("stays quiet while nobody is signed in", async () => {
    const fetchMock = respondWith(200, { data: [BOOK] });
    isAuthenticated.value = false;
    const api = mountSuggest();

    api.term.value = "alice";
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
