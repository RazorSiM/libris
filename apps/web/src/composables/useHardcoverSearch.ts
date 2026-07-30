import { useDebounceFn } from "@vueuse/core";
import { ApiError } from "./useApiClient";

export interface HardcoverSearchHit {
  source: string;
  normalized: {
    title?: string | null;
    author?: string | null;
    isbn10?: string | null;
    isbn13?: string | null;
    publisher?: string | null;
    publishedYear?: number | null;
    language?: string | null;
    description?: string | null;
    coverUrl?: string | null;
    pageCount?: number | null;
    series?: string | null;
    seriesIndex?: number | null;
    genres?: string[];
  };
  confidence: number;
}

export type HardcoverSearchError =
  | { kind: "disabled"; message: string }
  | { kind: "network"; message: string };

/**
 * Debounced free-text search against Hardcover. The query string is the user's
 * raw input; the server forwards it through the metadata client.
 */
export function useHardcoverSearch() {
  const client = useApiClient();
  const query = ref("");
  const results = ref<HardcoverSearchHit[]>([]);
  const loading = ref(false);
  const error = ref<HardcoverSearchError | null>(null);

  const run = useDebounceFn(async (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      results.value = [];
      loading.value = false;
      error.value = null;
      return;
    }

    loading.value = true;
    error.value = null;
    try {
      const res = await client.api.hardcover.search.$get({ query: { q: trimmed } });
      const body = (await res.json()) as { results: HardcoverSearchHit[] };
      results.value = body.results;
    } catch (e) {
      results.value = [];
      if (e instanceof ApiError && e.status === 503) {
        error.value = {
          kind: "disabled",
          message: "Hardcover isn't connected — set up a credential in Settings.",
        };
      } else {
        const message = e instanceof Error ? e.message : "Search failed";
        error.value = { kind: "network", message };
      }
    } finally {
      loading.value = false;
    }
  }, 300);

  watch(query, (q) => {
    if (q.trim().length >= 2) loading.value = true;
    void run(q);
  });

  function reset() {
    query.value = "";
    results.value = [];
    loading.value = false;
    error.value = null;
  }

  return { query, results, loading, error, reset };
}
