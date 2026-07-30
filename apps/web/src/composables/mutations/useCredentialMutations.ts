import { useMutation, useQueryCache } from "@pinia/colada";

type CredentialService = "opds" | "kosync" | "hardcover";

export function usePutCredential() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: { service: CredentialService; username: string; password: string }) => {
      await client.api.credentials[":service"].$put({
        param: { service: vars.service },
        json: { username: vars.username, password: vars.password },
      });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings"] }),
  });
}

export function useDeleteCredential() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (service: CredentialService) => {
      await client.api.credentials[":service"].$delete({
        param: { service },
      });
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["settings"] }),
  });
}
