import type { RouteLocationRaw, Router } from "vue-router";
import { useAuth } from "~/composables/useAuth";
import { setSessionRecovery } from "~/lib/session-invalidation";

/** Reachable without a session. Everything else redirects to sign-in. */
const PUBLIC_PATHS = new Set(["/login"]);

/**
 * Where to send someone who has no session, from where they are.
 *
 * fullPath rather than path: a deep link's query and hash are part of where
 * they meant to go, and dropping them lands them somewhere subtly different.
 * The home page is the exception — `?redirect=/` is noise that means nothing.
 */
function loginRoute(fullPath: string): RouteLocationRaw {
  return { path: "/login", query: fullPath === "/" ? {} : { redirect: fullPath } };
}

export function installRouterGuards(router: Router) {
  router.beforeEach(async (to) => {
    const { isAuthenticated, checked, check } = useAuth();

    if (!checked.value) {
      await check();
    }

    if (isAuthenticated.value || PUBLIC_PATHS.has(to.path)) return true;

    return loginRoute(to.fullPath);
  });

  installSessionRecovery(router);
}

/**
 * What the app does when the server refuses a session it believed in.
 *
 * The guard above only runs on navigation, and check() only runs once per page
 * load, so nothing in the app notices a session that dies while a tab sits
 * open — banned by an admin, revoked from another device, expired, or the
 * caller pointing "Set password" at their own row. Without this the tab keeps
 * rendering a signed-in shell over a dead cookie.
 *
 * The exit is the same one SettingsAccountSessions uses when you revoke your
 * own device: logout() (which clears the store AND the query cache, so the next
 * person to sign in here sees none of this user's data) and then /login.
 */
export function installSessionRecovery(router: Router) {
  setSessionRecovery(async () => {
    const { isAuthenticated, logout } = useAuth();
    // A 401 for someone the app already knows is signed out is not something
    // to recover from — a refused sign-in on /login is the ordinary case, and
    // reacting to it would clear the form the user is still typing in.
    if (!isAuthenticated.value) return;

    await logout();

    const from = router.currentRoute.value;
    // Already on /login: signing out is the whole job, and navigating again
    // would be a redirect loop.
    if (PUBLIC_PATHS.has(from.path)) return;

    await router.replace(loginRoute(from.fullPath));
  });
}
