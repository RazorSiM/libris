import { useQuery } from "@pinia/colada";

export function useReadingQuery(params: {
  status: Ref<string>;
  page: Ref<number>;
  search: Ref<string>;
  sort: Ref<string>;
  limit: number;
  parseSortParam: (value: string) => { sort: string; order: string };
}) {
  const client = useApiClient();

  return useQuery({
    key: () => [
      "reading",
      params.status.value,
      {
        page: params.page.value,
        search: params.search.value,
        sort: params.sort.value,
      },
    ],
    query: async () => {
      const { sort: sortField, order } = params.parseSortParam(params.sort.value);
      const res = await client.api["reading-status"][":status"].$get({
        param: { status: params.status.value as "reading" | "finished" | "unread" | "paused" },
        query: {
          page: String(params.page.value),
          limit: String(params.limit),
          search: params.search.value || "",
          sort: sortField as "title" | "author" | "percentage" | "lastRead",
          order: order as "asc" | "desc",
        },
      });
      if (!res.ok) throw new Error("Failed to load"); // type guard: narrows union to 200 response
      return res.json();
    },
    staleTime: 30_000,
  });
}
