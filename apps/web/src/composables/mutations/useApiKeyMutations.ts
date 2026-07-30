import { useMutation, useQuery, useQueryCache } from "@pinia/colada";

export function useApiKeysQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: ["api-keys"],
    query: async () => {
      const res = await client.api.auth.keys.$get();
      if (!res.ok) throw new Error("Failed to load API keys");
      return res.json();
    },
    enabled: () => isAuthenticated.value,
    staleTime: 30_000,
  });
}

export function useCreateApiKey() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (label: string) => {
      const res = await client.api.auth.keys.$post({ json: { label } });
      if (!res.ok) throw new Error("Failed to create API key");
      return res.json();
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["api-keys"] }),
  });
}

export function useDeleteApiKey() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (id: string) => {
      const res = await client.api.auth.keys[":id"].$delete({ param: { id } });
      if (!res.ok) {
        let message = "Failed to delete API key";

        try {
          const body = await res.json();
          if (
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string"
          ) {
            message = body.error;
          }
        } catch {
          const body = await res.text().catch(() => "");
          if (body) message = body;
        }

        throw new Error(message);
      }
    },
    onSettled: () => queryCache.invalidateQueries({ key: ["api-keys"] }),
  });
}

export function useSetup() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (label: string) => {
      const res = await client.api.auth.setup.$post({
        json: { label: label || "Web UI" },
      });
      if (!res.ok) throw new Error("Setup failed");
      return res.json();
    },
    onSettled: () =>
      Promise.all([
        queryCache.invalidateQueries({ key: ["api-keys"] }),
        queryCache.invalidateQueries({ key: ["settings"] }),
      ]),
  });
}
