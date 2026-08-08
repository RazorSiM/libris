import { useQuery } from "@pinia/colada";

export interface SearchSuggestion {
  id: string;
  title: string | null;
  author: string | null;
  status: "review" | "organized";
  coverUrl: string | null;
}

const DEBOUNCE_MS = 200;

/**
 * Command-palette book suggestions (`GET /api/search/suggest`).
 *
 * Keyed on the debounced term, so re-opening the palette and retyping the same
 * thing is served from the cache and two palettes cannot race each other.
 *
 * `results` is deliberately empty while `error` is set: the palette has never
 * shown a failure — it shows the navigation links and no books — and this
 * keeps that visible behaviour while making the failure readable by the
 * caller instead of swallowing it in a bare `catch`.
 */
export function useSearchSuggestQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();
  const { search: term, debouncedSearch } = useDebouncedSearch(DEBOUNCE_MS);

  const typed = computed(() => term.value.trim());
  const debouncedTyped = computed(() => debouncedSearch.value.trim());

  const {
    data,
    error,
    asyncStatus,
    status: queryStatus,
  } = useQuery({
    key: () => ["search", "suggest", debouncedTyped.value],
    query: () =>
      client.api.search.suggest.$get({ query: { q: debouncedTyped.value } }).then((r) => r.json()),
    enabled: () => isAuthenticated.value && debouncedTyped.value.length > 0,
    staleTime: 30_000,
  });

  const results = computed<SearchSuggestion[]>(() =>
    typed.value && !error.value ? ((data.value?.data ?? []) as SearchSuggestion[]) : [],
  );

  // True from the keystroke, not from the request: the debounce window and the
  // tick before Colada's watcher issues the fetch both look like "searching".
  const loading = computed(
    () =>
      typed.value.length > 0 &&
      (debouncedTyped.value !== typed.value ||
        asyncStatus.value === "loading" ||
        queryStatus.value === "pending"),
  );

  return { term, results, loading, error };
}
