import { useQuery } from "@pinia/colada";

export function useBookDetailQuery(id: Ref<string>) {
  const client = useApiClient();

  return useQuery({
    key: () => ["library", id.value],
    query: async () => {
      const res = await client.api.library[":id"].$get({ param: { id: id.value } });
      if (!res.ok) throw new Error("Not found"); // type guard: narrows union to 200 response
      return res.json();
    },
    staleTime: 30_000,
  });
}

/**
 * Metadata candidates fetched for a book from external sources.
 *
 * Event-triggered rather than key-driven: nothing wants these until the
 * pipeline announces `book:metadata-ready`, so the query stays disabled and the
 * caller drives it with `refetch()`. It is still a query, so the response is
 * cached under the book's own key and dropped by the same
 * `invalidateQueries({ key: ["library", id] })` that every book mutation
 * already issues — rather than sitting in a component-local ref that nothing
 * can invalidate and no second caller can share.
 */
export function useBookCandidatesQuery(id: MaybeRefOrGetter<string>) {
  const client = useApiClient();

  return useQuery({
    key: () => ["library", toValue(id), "candidates"],
    query: async () => {
      const res = await client.api.books[":id"].candidates.$get({ param: { id: toValue(id) } });
      if (!res.ok) throw new Error("Failed to fetch candidates"); // type guard: narrows union to 200 response
      return res.json();
    },
    enabled: false,
  });
}

export function useBookProgressQuery(id: Ref<string>) {
  const client = useApiClient();

  return useQuery({
    key: () => ["library", id.value, "progress"],
    query: async () => {
      const res = await client.api.library[":id"].progress.$get({ param: { id: id.value } });
      if (!res.ok) throw new Error("Not found"); // type guard: narrows union to 200 response
      return res.json();
    },
    staleTime: 30_000,
  });
}
