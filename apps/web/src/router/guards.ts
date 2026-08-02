import type { Router } from "vue-router";
import { useAuth } from "~/composables/useAuth";

/** Reachable without a session. Everything else redirects to sign-in. */
const PUBLIC_PATHS = new Set(["/login"]);

export function installRouterGuards(router: Router) {
  router.beforeEach(async (to) => {
    const { isAuthenticated, checked, check } = useAuth();

    if (!checked.value) {
      await check();
    }

    if (isAuthenticated.value || PUBLIC_PATHS.has(to.path)) return true;

    // Carry the intended destination so sign-in can return the user to it.
    // fullPath rather than path: a deep link's query and hash are part of where
    // they meant to go, and dropping them lands them somewhere subtly different.
    return {
      path: "/login",
      query: to.fullPath === "/" ? {} : { redirect: to.fullPath },
    };
  });
}
