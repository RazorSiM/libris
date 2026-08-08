import { useQuery } from "@pinia/colada";
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
 * `GET /api/hardcover/search` answers 503 — and only 503 — when the caller has
 * no usable Hardcover credential. That is not a failure the user can retry
 * their way out of, so it is surfaced as its own kind with its own copy rather
 * than as a red error line.
 */
export const HARDCOVER_DISABLED_MESSAGE =
  "Hardcover isn't connected — set up a credential in Settings.";

/** Below this the query is not worth spending a request on. */
const MIN_QUERY_LENGTH = 2;

const DEBOUNCE_MS = 300;

/**
 * Classify whatever the query threw. Exported so the 503 -> "disabled" mapping
 * can be pinned directly, without a round trip through the cache.
 */
export function toHardcoverSearchError(cause: unknown): HardcoverSearchError | null {
  if (!cause) return null;
  if (cause instanceof ApiError && cause.status === 503) {
    return { kind: "disabled", message: HARDCOVER_DISABLED_MESSAGE };
  }
  const message = (cause instanceof Error && cause.message) || "Search failed";
  return { kind: "network", message };
}

/**
 * Debounced free-text search against Hardcover. The query string is the user's
 * raw input; the server forwards it through the metadata client.
 *
 * The request itself is a Pinia Colada query keyed on the debounced term, so
 * repeating a search inside the stale window is served from the cache and two
 * components asking the same thing share one request. Only the debounce is
 * hand-rolled — Colada has no opinion about when a keystroke becomes a key.
 */
export function useHardcoverSearch() {
  const client = useApiClient();
  const { search: query, debouncedSearch } = useDebouncedSearch(DEBOUNCE_MS);

  const term = computed(() => query.value.trim());
  const debouncedTerm = computed(() => debouncedSearch.value.trim());

  /** What the user has typed is worth searching for. */
  const active = computed(() => term.value.length >= MIN_QUERY_LENGTH);
  /** ...and the debounce has caught up, so a request may be issued. */
  const settled = computed(() => debouncedTerm.value.length >= MIN_QUERY_LENGTH);

  const {
    data,
    error: queryError,
    asyncStatus,
    status,
  } = useQuery({
    key: () => ["hardcover", "search", debouncedTerm.value],
    query: async () => {
      const res = await client.api.hardcover.search.$get({ query: { q: debouncedTerm.value } });
      return (await res.json()) as { results: HardcoverSearchHit[] };
    },
    enabled: () => settled.value,
    staleTime: 60_000,
  });

  const error = computed<HardcoverSearchError | null>(() =>
    active.value ? toHardcoverSearchError(queryError.value) : null,
  );

  // Colada keeps the last good data on an entry that later errors; the panel
  // has always shown either results or an error, never both.
  const results = computed<HardcoverSearchHit[]>(() =>
    active.value && !error.value ? (data.value?.results ?? []) : [],
  );

  // A keystroke the debounce has not yet released is still "searching" as far
  // as the user is concerned — the request simply has not gone out yet. The
  // same goes for the tick between a new term reaching the key and Colada's
  // watcher issuing the request: `pending` means this term has neither an
  // answer nor an error yet, which is exactly the spinner's condition.
  const loading = computed(
    () =>
      active.value &&
      (debouncedTerm.value !== term.value ||
        asyncStatus.value === "loading" ||
        status.value === "pending"),
  );

  function reset() {
    query.value = "";
    debouncedSearch.value = "";
  }

  return { query, results, loading, error, reset };
}
