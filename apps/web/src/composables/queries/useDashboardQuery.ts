import { useQuery } from "@pinia/colada";

export function useDashboardQuery() {
  const client = useApiClient();

  return useQuery({
    key: ["dashboard"],
    query: () => client.api.dashboard.$get().then((r) => r.json()),
    staleTime: 30_000,
  });
}
