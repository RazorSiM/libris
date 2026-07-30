import { defineQuery, useQuery } from "@pinia/colada";

export const useSettingsStatusQuery = defineQuery(() => {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  const { state, refresh, refetch, ...rest } = useQuery({
    key: ["settings", "status"],
    query: () => client.api.settings.status.$get().then((r) => r.json()),
    enabled: () => isAuthenticated.value,
    staleTime: 30_000,
  });

  const healthData = computed(() => state.value.data?.health);
  const jobData = computed(() =>
    state.value.data?.queues ? { queues: state.value.data.queues } : undefined,
  );
  const failedJobsData = computed(
    () => state.value.data?.failedJobs ?? { jobs: [] as never[], total: 0 },
  );
  const appSettings = computed(() => state.value.data?.settings);
  const opdsCredentials = computed(() => state.value.data?.credentials.opds);
  const kosyncCredentials = computed(() => state.value.data?.credentials.kosync);
  const hardcoverCredentials = computed(() => state.value.data?.credentials.hardcover);

  return {
    ...rest,
    state,
    refresh,
    refetch,
    healthData,
    jobData,
    failedJobsData,
    appSettings,
    opdsCredentials,
    kosyncCredentials,
    hardcoverCredentials,
  };
});
