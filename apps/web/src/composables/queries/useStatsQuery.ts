import { useQuery } from "@pinia/colada";
import type { MaybeRef } from "vue";

export function useStatsQuery(year?: MaybeRef<number | undefined>) {
  const client = useApiClient();
  const yearRef = ref(year);

  return useQuery({
    key: () => ["stats", yearRef.value ?? "current"],
    query: () => {
      const y = yearRef.value;
      const query = y ? { year: String(y) } : {};
      return client.api.stats.$get({ query }).then((r) => r.json());
    },
    staleTime: 30_000,
  });
}
