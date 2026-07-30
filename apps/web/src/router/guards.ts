import type { Router } from "vue-router";
import { useAuth } from "~/composables/useAuth";

export function installRouterGuards(router: Router) {
  router.beforeEach(async (to) => {
    const { isAuthenticated, checked, check } = useAuth();

    if (!checked.value) {
      await check();
    }

    if (!isAuthenticated.value && to.path !== "/settings") {
      return { path: "/settings" };
    }
    return true;
  });
}
