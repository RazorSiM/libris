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
  const {
    authenticated,
    checked,
    admin,
    name,
    email,
    userId: storedUserId,
    generation,
    inFlight,
  } = storeToRefs(store);

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

  /**
   * Declare that who is signed in has changed.
   *
   * Everything that moves the app between identities — signing in, signing
   * out, being signed out by the server — goes through here, and the two lines
   * are what make the move stick: the bump invalidates any session request
   * already on the wire, and dropping the shared promise stops a later check()
   * from awaiting an answer about the previous identity.
   *
   * Both fields live in the store rather than in this closure. useAuth() has no
   * memoisation, so a counter declared here would be private to one caller and
   * would guard nothing across the call sites that actually race.
   */
  function beginNewSession() {
    generation.value++;
    inFlight.value = null;
  }

  async function check() {
    if (checked.value) return;
    const existing = inFlight.value;
    if (existing) return existing;

    const gen = generation.value;
    const request = (async () => {
      try {
        const { data } = await authClient.getSession();
        // If who is signed in changed while we were waiting (e.g. logout on a
        // different useAuth() instance), this answer is about somebody else.
        if (gen !== generation.value) return;
        if (data?.user) {
          authenticated.value = true;
          admin.value = data.user.role === "admin";
          name.value = data.user.name ?? null;
          email.value = data.user.email ?? null;
          storedUserId.value = data.user.id;
        } else {
          clearAuthState();
        }
        checked.value = true;
      } catch {
        if (gen !== generation.value) return;
        clearAuthState();
        checked.value = true;
      } finally {
        // Only if the slot is still ours. Every replacement of it goes through
        // beginNewSession(), which bumps the generation, so an unchanged
        // generation means nobody has taken it — and clearing a NEWER caller's
        // request would make the next check() fire a second one.
        if (gen === generation.value) inFlight.value = null;
      }
    })();
    inFlight.value = request;
    return request;
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

    // Before anything else: a check() still in flight is asking about whoever
    // was signed in a moment ago, and without this the await below would hand
    // back THEIR session as the new one.
    beginNewSession();
    clearFrontendQueryCache();
    clearAuthState();
    authenticated.value = true;
    // Force check() to run: the sign-in response does not carry the role.
    checked.value = false;
    await check();
  }

  async function logout() {
    // Locally first, then the network. Clearing before the round-trip means the
    // UI is never rendering a signed-in shell for a session the user has
    // already ended, and a failed sign-out cannot strand them in one — the
    // cookie may survive, but the next check() will discover that.
    beginNewSession();
    clearAuthState();
    checked.value = true;
    clearFrontendQueryCache();
    try {
      await authClient.signOut();
    } catch {
      // Deliberately swallowed; see above.
    }
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
    // Not just `checked = false`: a request already in flight was issued before
    // whatever the caller just changed, so awaiting it would return the state
    // refresh() exists to get past.
    beginNewSession();
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
