import { useQuery } from "@pinia/colada";

export function useSeriesListQuery(params: { q: Ref<string> }) {
  const client = useApiClient();

  return useQuery({
    key: () => ["series", { q: params.q.value }],
    query: () =>
      client.api.series
        .$get({
          query: {
            q: params.q.value || "",
          },
        })
        .then((r) => r.json()),
    staleTime: 30_000,
  });
}

export function useSeriesDetailQuery(name: Ref<string>) {
  const client = useApiClient();

  return useQuery({
    key: () => ["series", name.value],
    query: async () => {
      const res = await client.api.series[":name"].$get({ param: { name: name.value } });
      if (!res.ok) throw new Error("Not found"); // type guard: narrows union to 200 response
      return res.json();
    },
    staleTime: 30_000,
  });
}
