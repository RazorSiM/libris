import { useQuery } from "@pinia/colada";

export function useHardcoverStatusQuery(credentialConfigured: Ref<boolean>) {
  const client = useApiClient();

  return useQuery({
    key: ["settings", "hardcover-status"],
    query: () => client.api.hardcover.status.$get().then((r) => r.json()),
    enabled: () => credentialConfigured.value,
    staleTime: 60_000,
  });
}
