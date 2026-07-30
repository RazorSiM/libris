import { useQuery } from "@pinia/colada";
import type { MetadataSource } from "@libris/api-hono/types";
import { inboxKeys } from "./inboxKeys";

export function useInboxDetailQuery(id: string, enabled: Readonly<Ref<boolean>> = ref(true)) {
  const client = useApiClient();

  return useQuery({
    key: () => inboxKeys.detail(id),
    query: async () => {
      const res = await client.api.inbox[":id"].$get({ param: { id } });
      if (!res.ok) throw new Error("Not found"); // type guard: narrows union to 200 response
      const json = await res.json();
      return {
        ...json,
        candidates: json.candidates.map((c) => ({
          ...c,
          source: c.source as MetadataSource,
          normalized: c.normalized as Record<string, unknown>,
        })),
      };
    },
    enabled: () => enabled.value,
    staleTime: 30_000,
  });
}
