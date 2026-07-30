import { useQuery } from "@pinia/colada";

export function useHardcoverSyncLogQuery(enabled: Ref<boolean>) {
  const client = useApiClient();

  return useQuery({
    key: ["settings", "hardcover-sync-log"],
    query: () =>
      client.api.hardcover.sync.log.$get({ query: { limit: "20" } }).then((r) => r.json()),
    enabled: () => enabled.value,
    staleTime: 30_000,
  });
}
