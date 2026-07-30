import { useMutation, useQueryCache } from "@pinia/colada";

type PatchSettingsBody = {
  hardcoverMetadataEnabled?: boolean;
  hardcoverSyncEnabled?: boolean;
};

export function usePatchSettings() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (data: PatchSettingsBody) => {
      await client.api.settings.$patch({ json: data });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings"] }),
  });
}

export function useTriggerHardcoverSync() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async () => {
      await client.api.hardcover.sync.$post();
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings", "hardcover-status"] }),
  });
}
