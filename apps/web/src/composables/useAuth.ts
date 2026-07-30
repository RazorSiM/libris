import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useMutation, useQueryCache } from "@pinia/colada";
import { useAuthStore } from "~/stores/auth";
import { useApiClient } from "~/composables/useApiClient";

export function useAuth() {
  const queryCache = useQueryCache();
  const store = useAuthStore();
  const { authenticated, checked, admin, label, keyId } = storeToRefs(store);

  const isAuthenticated = computed(() => authenticated.value);
  const isAdmin = computed(() => admin.value);
  const userLabel = computed(() => label.value);
  const apiKeyId = computed(() => keyId.value);

  function clearFrontendQueryCache() {
    queryCache.cancelQueries({});
    for (const entry of queryCache.getEntries()) {
      queryCache.remove(entry);
    }
  }

  // Generation counter to prevent stale check() responses from overwriting
  // auth state that changed while the request was in-flight (e.g. logout
  // happening while a login-triggered check is still pending).
  let authGeneration = 0;
  let pending: Promise<void> | null = null;

  async function check() {
    if (checked.value) return;
    if (pending) return pending;
    const gen = authGeneration;
    pending = (async () => {
      try {
        const client = useApiClient();
        const res = await client.api.auth.session.$get();
        const data = await res.json();
        // If auth state changed while we were waiting (e.g. logout), discard
        if (gen !== authGeneration) return;
        authenticated.value = data.authenticated;
        admin.value = data.isAdmin ?? false;
        label.value = data.label ?? null;
        keyId.value = data.apiKeyId ?? null;
      } catch {
        if (gen !== authGeneration) return;
        authenticated.value = false;
        admin.value = false;
        label.value = null;
        keyId.value = null;
      }
      checked.value = true;
      pending = null;
    })();
    return pending;
  }

  const loginMutation = useMutation({
    mutation: async (apiKey: string) => {
      const client = useApiClient();
      const res = await client.api.auth.login.$post({ json: { apiKey } });
      if (!res.ok) {
        throw new Error("Invalid API key");
      }
      return res.json();
    },
    onSuccess: () => {
      clearFrontendQueryCache();
      authenticated.value = true;
      checked.value = false;
      admin.value = false;
      label.value = null;
      keyId.value = null;
    },
  });

  async function login(apiKey: string) {
    try {
      await loginMutation.mutateAsync(apiKey);
      // Fetch session details (isAdmin, label) after successful login
      await check();
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid API key") {
        throw error;
      }
      throw new Error("Network error, please try again");
    }
  }

  async function logout() {
    // Bump generation to invalidate any in-flight check() that might
    // re-authenticate after we clear state.
    authGeneration++;
    const client = useApiClient();
    await client.api.auth.logout.$post();
    authenticated.value = false;
    admin.value = false;
    label.value = null;
    keyId.value = null;
    clearFrontendQueryCache();
  }

  async function setAuthenticated(value: boolean) {
    authenticated.value = value;
    checked.value = true;
    if (value) {
      // Re-fetch session details (isAdmin, label) after auth state change
      checked.value = false;
      await check();
    }
  }

  return {
    isAuthenticated,
    isAdmin,
    userLabel,
    apiKeyId,
    checked,
    check,
    login,
    logout,
    setAuthenticated,
  };
}
