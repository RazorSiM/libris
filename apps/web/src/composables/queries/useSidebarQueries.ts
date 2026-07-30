import { useQuery } from "@pinia/colada";
import { inboxKeys } from "./inboxKeys";

export function useInboxCountQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: inboxKeys.count(),
    query: () => client.api.inbox.count.$get().then((r) => r.json()),
    enabled: () => isAuthenticated.value,
    staleTime: 30_000,
  });
}

export function useFailedJobsCountQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: ["jobs", "failed"],
    query: () => client.api.jobs.failed.$get().then((r) => r.json()),
    enabled: () => isAuthenticated.value,
    staleTime: 30_000,
  });
}

export function useReadingCountsQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: ["reading", "counts"],
    query: () => client.api["reading-status"].counts.$get().then((r) => r.json()),
    enabled: () => isAuthenticated.value,
    staleTime: 30_000,
  });
}
