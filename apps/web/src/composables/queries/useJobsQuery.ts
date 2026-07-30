import { defineQuery, useQuery } from "@pinia/colada";

export interface JobFilters {
  queue?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export const useJobsQuery = defineQuery(() => {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  const filters = reactive<JobFilters>({
    queue: undefined,
    status: undefined,
    page: 1,
    pageSize: 20,
  });

  const { state, refresh, refetch, ...rest } = useQuery({
    key: () => [
      "jobs",
      "list",
      filters.queue ?? "all",
      filters.status ?? "all",
      filters.page,
      filters.pageSize,
    ],
    query: () => {
      const query: Record<string, string> = {
        page: String(filters.page),
        pageSize: String(filters.pageSize),
      };
      if (filters.queue) query.queue = filters.queue;
      if (filters.status) query.status = filters.status;
      return client.api.jobs.$get({ query }).then((r) => r.json());
    },
    enabled: () => isAuthenticated.value,
    staleTime: 15_000,
  });

  return {
    ...rest,
    state,
    refresh,
    refetch,
    filters,
  };
});
