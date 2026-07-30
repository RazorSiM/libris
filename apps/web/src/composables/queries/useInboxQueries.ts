import { useQuery } from "@pinia/colada";
import { inboxKeys } from "./inboxKeys";

export function useInboxListQuery(params: {
  page: Ref<number>;
  search: Ref<string>;
  sort: Ref<string>;
  limit: number;
}) {
  const client = useApiClient();

  return useQuery({
    key: () => [
      ...inboxKeys.list(),
      {
        page: params.page.value,
        search: params.search.value,
        sort: params.sort.value,
      },
    ],
    query: () =>
      client.api.inbox
        .$get({
          query: {
            page: String(params.page.value),
            limit: String(params.limit),
            q: params.search.value || "",
            sort: params.sort.value as "title_asc",
          },
        })
        .then((r) => r.json()),
    staleTime: 30_000,
  });
}

export function useInboxProcessingQuery(enabled: Ref<boolean>) {
  const client = useApiClient();

  return useQuery({
    key: inboxKeys.processing(),
    query: () =>
      client.api.inbox.processing
        .$get()
        .then((r) => r.json())
        .then((d) => d.processing),
    enabled: () => enabled.value,
    staleTime: 10_000,
  });
}
