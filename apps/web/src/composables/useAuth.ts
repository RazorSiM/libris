import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useQueryCache } from "@pinia/colada";
import { useAuthStore } from "~/stores/auth";
import { authClient } from "~/lib/auth-client";

/**
 * The app's view of who is signed in.
 *
 * A dozen call sites read this, and none of them should touch authClient. The
 * boundary is the point: everything about how a session is fetched, cached and
 * cleared lives here, so a change in transport touches one file.
 */
export function useAuth() {
  const queryCache = useQueryCache();
  const store = useAuthStore();
  const { authenticated, checked, admin, name, email, userId: storedUserId } = storeToRefs(store);

  const isAuthenticated = computed(() => authenticated.value);
  const isAdmin = computed(() => admin.value);
  const userId = computed(() => storedUserId.value);
  const userName = computed(() => name.value);
  const userEmail = computed(() => email.value);
  /** What to call someone in the chrome: their name, or their address if unset. */
  const userLabel = computed(() => name.value ?? email.value ?? null);

  function clearFrontendQueryCache() {
    queryCache.cancelQueries({});
    for (const entry of queryCache.getEntries()) {
      queryCache.remove(entry);
    }
  }

  function clearAuthState() {
    authenticated.value = false;
    admin.value = false;
    name.value = null;
    email.value = null;
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
          name.value = data.user.name ?? null;
          email.value = data.user.email ?? null;
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

  /**
   * Re-read the session even though it has already been checked.
   *
   * check() is a once-per-load cache, which is right for the guard that calls
   * it on every navigation and wrong after something changes the session's
   * contents — renaming yourself, or a role change — because the stale copy is
   * what the sidebar renders.
   */
  async function refresh() {
    checked.value = false;
    await check();
  }

  async function setAuthenticated(value: boolean) {
    authenticated.value = value;
    checked.value = true;
    if (value) await refresh();
  }

  return {
    isAuthenticated,
    isAdmin,
    userLabel,
    userName,
    userEmail,
    userId,
    checked,
    check,
    refresh,
    login,
    logout,
    setAuthenticated,
  };
}
