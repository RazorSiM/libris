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
