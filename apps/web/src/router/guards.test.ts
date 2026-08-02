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

vi.mock("~/composables/useAuth", () => ({
  useAuth: () => ({
    isAuthenticated: computed(() => authenticated.value),
    checked,
    check,
  }),
}));

const { installRouterGuards } = await import("./guards");

/** Capture the guard the installer registers, so it can be called directly. */
type Guard = (to: { path: string; fullPath: string }) => Promise<unknown>;
function makeGuard(): Guard {
  let guard!: Guard;
  installRouterGuards({ beforeEach: (fn: Guard) => (guard = fn) } as never);
  return guard;
}

beforeEach(() => {
  authenticated.value = false;
  checked.value = false;
  check.mockClear();
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
