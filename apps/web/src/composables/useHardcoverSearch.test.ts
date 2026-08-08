// @vitest-environment happy-dom
/**
 * Hardcover search, driven through a REAL Pinia Colada query and a REAL
 * useApiClient(). Only the network is replaced.
 *
 * Two things are load-bearing here and neither is visible from the query
 * function alone:
 *
 * 1. A 503 is not a failure the user can retry out of — it means nobody has
 *    connected a Hardcover credential — so it maps to its own `disabled` kind
 *    with its own copy. `HardcoverSearchPanel` renders that in muted text and
 *    everything else in red. Collapsing the two would show a red "Hardcover
 *    metadata search is disabled" to someone who simply has not set it up.
 * 2. The search now goes through the query cache, so repeating a term inside
 *    the stale window spends no request. The hand-rolled version this replaced
 *    issued one every time the debounce fired.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { computed, defineComponent, h, nextTick, ref, watch } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { PiniaColada } from "@pinia/colada";

const apiClient = await import("~/composables/useApiClient");
const debounced = await import("~/composables/useDebouncedSearch");

// What the auto-import plugin normally injects into composable scope.
Object.assign(globalThis, {
  ref,
  computed,
  watch,
  useApiClient: apiClient.useApiClient,
  useDebouncedSearch: debounced.useDebouncedSearch,
});

const { useHardcoverSearch, toHardcoverSearchError, HARDCOVER_DISABLED_MESSAGE } =
  await import("./useHardcoverSearch");
const { ApiError } = apiClient;

type Search = ReturnType<typeof useHardcoverSearch>;

const HIT = {
  source: "hardcover",
  normalized: { title: "Dune", author: "Frank Herbert" },
  confidence: 0.9,
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

/** Answer every request with this status and body; returns the spy. */
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

/** Mount the composable inside a real component with a fresh cache. */
function mountSearch() {
  let api!: Search;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useHardcoverSearch();
        return () => h("div");
      },
    }),
    { global: { plugins: [createPinia(), PiniaColada] } },
  );
  return { api, wrapper };
}

/** Let the 300ms debounce fire and the request resolve. */
async function settle() {
  await vi.advanceTimersByTimeAsync(400);
  await flushPromises();
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useHardcoverSearch()", () => {
  it("maps a 503 to the disabled kind, with the copy the panel shows", async () => {
    // GET /api/hardcover/search answers 503 — and only 503 — when the caller
    // has no usable Hardcover token. If this arrived as `network`, the panel
    // would render the server's internal wording in red instead of telling
    // the user where to go and fix it.
    respondWith(503, { error: "Hardcover credential not configured" });
    const { api } = mountSearch();

    api.query.value = "dune";
    await settle();

    expect(api.error.value).toEqual({
      kind: "disabled",
      message: "Hardcover isn't connected — set up a credential in Settings.",
    });
    expect(api.results.value).toEqual([]);
    expect(api.loading.value).toBe(false);
  });

  it("maps any other failure to the network kind, carrying the server's message", async () => {
    respondWith(500, { error: "upstream exploded" });
    const { api } = mountSearch();

    api.query.value = "dune";
    await settle();

    expect(api.error.value).toEqual({ kind: "network", message: "upstream exploded" });
    expect(api.results.value).toEqual([]);
  });

  it("returns the server's hits and asks for the trimmed term", async () => {
    const fetchMock = respondWith(200, { results: [HIT] });
    const { api } = mountSearch();

    api.query.value = "  dune  ";
    await settle();

    expect(api.results.value).toEqual([HIT]);
    expect(api.error.value).toBeNull();
    expect(api.loading.value).toBe(false);
    expect(requestedUrl(fetchMock.mock.calls[0]![0])).toContain("q=dune");
  });

  it("spends no request below two characters", async () => {
    const fetchMock = respondWith(200, { results: [HIT] });
    const { api } = mountSearch();

    api.query.value = "d";
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.results.value).toEqual([]);
    expect(api.loading.value).toBe(false);
  });

  it("reports loading from the keystroke, not from the request", async () => {
    respondWith(200, { results: [HIT] });
    const { api } = mountSearch();

    api.query.value = "dune";
    await nextTick();

    // Still inside the debounce window: nothing is on the wire yet, but the
    // user has typed and the panel must show the spinner rather than "No
    // matches on Hardcover."
    expect(api.loading.value).toBe(true);

    await settle();
    expect(api.loading.value).toBe(false);
  });

  it("serves a repeated term from the cache instead of re-requesting", async () => {
    // The assertion that fails against the hand-rolled version: it called the
    // API once per debounce fire, with no cache and no dedup.
    const fetchMock = respondWith(200, { results: [HIT] });
    const { api } = mountSearch();

    api.query.value = "dune";
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    api.query.value = "dune fear";
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    api.query.value = "dune";
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.results.value).toEqual([HIT]);
  });

  it("clears query, results and error on reset()", async () => {
    respondWith(503, { error: "Hardcover credential not configured" });
    const { api } = mountSearch();

    api.query.value = "dune";
    await settle();
    expect(api.error.value?.kind).toBe("disabled");

    api.reset();
    await settle();

    expect(api.query.value).toBe("");
    expect(api.results.value).toEqual([]);
    expect(api.error.value).toBeNull();
    expect(api.loading.value).toBe(false);
  });
});

describe("toHardcoverSearchError()", () => {
  it("only treats a 503 as disabled", () => {
    expect(toHardcoverSearchError(new ApiError(503, ""))).toEqual({
      kind: "disabled",
      message: HARDCOVER_DISABLED_MESSAGE,
    });
    expect(toHardcoverSearchError(new ApiError(500, ""))?.kind).toBe("network");
    expect(toHardcoverSearchError(new ApiError(404, ""))?.kind).toBe("network");
  });

  it("falls back to a generic message for a non-Error rejection", () => {
    expect(toHardcoverSearchError("boom")).toEqual({ kind: "network", message: "Search failed" });
  });

  it("classifies nothing when there is no error", () => {
    expect(toHardcoverSearchError(null)).toBeNull();
  });
});
