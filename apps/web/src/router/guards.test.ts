// @vitest-environment happy-dom
/**
 * Router auth guard (libris-5ng.18).
 *
 * The guard is four lines, and each one is a decision that is wrong in an
 * interesting way if you get it backwards: sending a signed-out user in a
 * loop, dropping the deep link they clicked, or bouncing them off the very
 * page that would let them sign in.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { computed, ref } from "vue";

const authenticated = ref(false);
const checked = ref(false);
const check = vi.fn(async () => {
  checked.value = true;
});
const logout = vi.fn(async () => {
  authenticated.value = false;
  checked.value = true;
});

vi.mock("~/composables/useAuth", () => ({
  useAuth: () => ({
    isAuthenticated: computed(() => authenticated.value),
    checked,
    check,
    logout,
  }),
}));

const { installRouterGuards, installSessionRecovery } = await import("./guards");
const { reportSessionInvalidated, setSessionRecovery } = await import("~/lib/session-invalidation");

/** Capture the guard the installer registers, so it can be called directly. */
type Guard = (to: { path: string; fullPath: string }) => Promise<unknown>;
function makeGuard(): Guard {
  let guard!: Guard;
  installRouterGuards({
    beforeEach: (fn: Guard) => (guard = fn),
    currentRoute: ref({ path: "/", fullPath: "/" }),
    replace: vi.fn(),
  } as never);
  return guard;
}

beforeEach(() => {
  authenticated.value = false;
  checked.value = false;
  check.mockClear();
  logout.mockClear();
  setSessionRecovery(null);
});

describe("auth guard", () => {
  it("resolves the session once before deciding", async () => {
    await makeGuard()({ path: "/", fullPath: "/" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("lets a signed-in user through", async () => {
    authenticated.value = true;
    checked.value = true;
    expect(await makeGuard()({ path: "/library", fullPath: "/library" })).toBe(true);
  });

  it("sends a signed-out user to /login", async () => {
    expect(await makeGuard()({ path: "/library", fullPath: "/library" })).toEqual({
      path: "/login",
      query: { redirect: "/library" },
    });
  });

  it("preserves the query and hash of a deep link", async () => {
    // Redirecting to the bare path would land the user on the right page with
    // the wrong filters, which reads as the app losing their click.
    const to = { path: "/library", fullPath: "/library?author=Wight&sort=title#top" };
    expect(await makeGuard()(to)).toEqual({
      path: "/login",
      query: { redirect: "/library?author=Wight&sort=title#top" },
    });
  });

  it("does not add a redirect for the home page", async () => {
    // ?redirect=/ is noise in the address bar and means nothing extra.
    expect(await makeGuard()({ path: "/", fullPath: "/" })).toEqual({
      path: "/login",
      query: {},
    });
  });

  it("never bounces a signed-out user off /login itself", async () => {
    // The loop this prevents is total: the guard redirects to /login, which
    // the guard then redirects to /login, forever.
    expect(await makeGuard()({ path: "/login", fullPath: "/login" })).toBe(true);
  });
});

/**
 * Recovery from a session killed on the server.
 *
 * The guard above runs on navigation and check() runs once per page load, so
 * without this nothing in a tab that is already open ever discovers that its
 * cookie stopped working — a ban, a revoke from another device, an admin
 * setting your password, plain expiry. The tab keeps rendering a signed-in
 * shell while every request 401s into a toast.
 */
describe("session recovery", () => {
  /** A router stub sitting on `where`, with its replace() calls recorded. */
  function routerAt(path: string, fullPath = path) {
    const replace = vi.fn(async () => {});
    installSessionRecovery({
      currentRoute: ref({ path, fullPath }),
      replace,
    } as never);
    return replace;
  }

  /** reportSessionInvalidated() is fire-and-forget; let its promise chain run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("signs out and redirects when the server refuses the session", async () => {
    authenticated.value = true;
    const replace = routerAt("/library", "/library?author=Wight");

    reportSessionInvalidated();
    await settle();

    expect(logout).toHaveBeenCalledTimes(1);
    // The deep link is carried, same as the guard: a session that expires
    // mid-browse should return you where you were, not to the dashboard.
    expect(replace).toHaveBeenCalledWith({
      path: "/login",
      query: { redirect: "/library?author=Wight" },
    });
  });

  it("signs out and redirects exactly once for a burst of 401s", async () => {
    // A page mounting six components fires six queries; if the session died,
    // all six come back 401. Six sign-outs and six redirects is a visible mess.
    authenticated.value = true;
    const replace = routerAt("/");

    reportSessionInvalidated();
    reportSessionInvalidated();
    reportSessionInvalidated();
    await settle();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("does not navigate when the user is already on /login", async () => {
    // The redirect loop this prevents: /login 401s on something, recovery
    // replaces with /login, which 401s again.
    authenticated.value = true;
    const replace = routerAt("/login");

    reportSessionInvalidated();
    await settle();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores a 401 for someone who is already signed out", async () => {
    // A refused sign-in on the login page is a 401 too. Reacting to it would
    // clear the form the user is still typing in.
    authenticated.value = false;
    const replace = routerAt("/login");

    reportSessionInvalidated();
    await settle();

    expect(logout).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays armed after a recovery, and after one that throws", async () => {
    authenticated.value = true;
    const replace = routerAt("/library");

    reportSessionInvalidated();
    await settle();
    expect(replace).toHaveBeenCalledTimes(1);

    // A second, later invalidation must still be handled — a latch that stuck
    // shut would silently disable recovery for the rest of the page's life.
    authenticated.value = true;
    replace.mockRejectedValueOnce(new Error("navigation cancelled"));
    reportSessionInvalidated();
    await settle();
    expect(replace).toHaveBeenCalledTimes(2);

    authenticated.value = true;
    reportSessionInvalidated();
    await settle();
    expect(replace).toHaveBeenCalledTimes(3);
  });
});
