import { useMutation, useQuery, useQueryCache } from "@pinia/colada";

/**
 * App passwords — the credential an e-reader, OPDS client or script uses.
 *
 * A credential belongs to a person and is managed by that person: there is no
 * admin gate on creating one, and the list only ever contains your own.
 * Creating accounts for other people is admin user management instead.
 *
 * The query key is "api-keys" rather than "app-passwords" so that every
 * invalidation call site agrees on one string.
 */

export function useApiKeysQuery() {
  const client = useApiClient();
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: ["api-keys"],
    query: async () => {
      const res = await client.api["app-passwords"].$get();
      if (!res.ok) throw new Error("Failed to load app passwords");
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
    // Returns the plaintext credential, and this is the only time it exists —
    // the server stores a hash. The caller must show it to the user now.
    mutation: async (name: string) => {
      const res = await client.api["app-passwords"].$post({ json: { name } });
      if (!res.ok) throw new Error("Failed to create app password");
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
      const res = await client.api["app-passwords"][":id"].$delete({ param: { id } });
      if (!res.ok) {
        let message = "Failed to revoke app password";

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

/**
 * First-run bootstrap: create the first admin on an empty install.
 *
 * Takes an account rather than a key label now — the endpoint creates a person
 * who then signs in, instead of minting a credential that WAS the person. It
 * 409s once any user exists, so it is safe to leave wired up.
 */
export function useSetup() {
  const client = useApiClient();
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: { email: string; password: string; name: string }) => {
      const res = await client.api.setup.$post({ json: vars });
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
