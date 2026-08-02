import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useQueryCache } from "@pinia/colada";
import { useAuthStore } from "~/stores/auth";
import { authClient } from "~/lib/auth-client";

/**
 * The app's view of who is signed in.
 *
 * The surface is unchanged from the API-key era on purpose — a dozen call
 * sites depend on it — but everything underneath now goes through the Better
 * Auth client. `login` is the one exception: it takes an email and password
 * instead of a key, because there is no key to paste any more.
 *
 * No call site outside this file should touch authClient. Keeping the boundary
 * here is what let the transport change without the app noticing.
 */
export function useAuth() {
  const queryCache = useQueryCache();
  const store = useAuthStore();
  const { authenticated, checked, admin, label, userId: storedUserId } = storeToRefs(store);

  const isAuthenticated = computed(() => authenticated.value);
  const isAdmin = computed(() => admin.value);
  const userLabel = computed(() => label.value);
  const userId = computed(() => storedUserId.value);

  function clearFrontendQueryCache() {
    queryCache.cancelQueries({});
    for (const entry of queryCache.getEntries()) {
      queryCache.remove(entry);
    }
  }

  function clearAuthState() {
    authenticated.value = false;
    admin.value = false;
    label.value = null;
    storedUserId.value = null;
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
        const { data } = await authClient.getSession();
        // If auth state changed while we were waiting (e.g. logout), discard
        if (gen !== authGeneration) return;
        if (data?.user) {
          authenticated.value = true;
          admin.value = data.user.role === "admin";
          label.value = data.user.name ?? data.user.email ?? null;
          storedUserId.value = data.user.id;
        } else {
          clearAuthState();
        }
      } catch {
        if (gen !== authGeneration) return;
        clearAuthState();
      }
      checked.value = true;
      pending = null;
    })();
    return pending;
  }

  /**
   * Sign in with email and password.
   *
   * Throws two distinguishable errors on purpose: the login page tells the
   * user to check their password in one case and to try again in the other,
   * and collapsing them sends people chasing the wrong problem.
   */
  async function login(email: string, password: string) {
    let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
    try {
      result = await authClient.signIn.email({ email, password });
    } catch {
      throw new Error("Network error, please try again");
    }
    if (result.error) {
      // A throttled attempt is NOT a wrong password, and saying so sends the
      // user to reset a password that was fine. Generic text is the right
      // answer for a rejected credential; it is the wrong answer for a 429.
      if (result.error.status === 429) {
        throw new Error("Too many sign-in attempts. Please wait a moment and try again.");
      }
      throw new Error(result.error.message ?? "Invalid email or password");
    }

    clearFrontendQueryCache();
    clearAuthState();
    authenticated.value = true;
    // Force check() to run: the sign-in response does not carry the role.
    checked.value = false;
    await check();
  }

  async function logout() {
    // Bump generation to invalidate any in-flight check() that might
    // re-authenticate after we clear state.
    authGeneration++;
    pending = null;
    try {
      await authClient.signOut();
    } catch {
      // A failed sign-out request must not strand the user in a signed-in UI.
      // The cookie may survive, but the next check() will discover that.
    }
    clearAuthState();
    checked.value = true;
    clearFrontendQueryCache();
  }

  async function setAuthenticated(value: boolean) {
    authenticated.value = value;
    checked.value = true;
    if (value) {
      // Re-fetch session details (role, name) after auth state change
      checked.value = false;
      await check();
    }
  }

  return {
    isAuthenticated,
    isAdmin,
    userLabel,
    userId,
    checked,
    check,
    login,
    logout,
    setAuthenticated,
  };
}
