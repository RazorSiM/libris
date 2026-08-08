// @vitest-environment happy-dom
/**
 * The app's answer to a re-scoped socket.
 *
 * `server-events.test.ts` pins the plugin's half — that a 4409 asks for a
 * refresh, waits for it, and dials exactly once. This pins the other half: that
 * what gets installed actually re-reads the session, and that it does so
 * through refresh() rather than check().
 *
 * The distinction is the whole bug. check() short-circuits on `checked`, which
 * every navigation has already set, so the obvious wiring — "ask again" — is a
 * no-op that leaves the sidebar exactly as stale as it was.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// useAuth() reaches for @pinia/colada's query cache; a real one needs a full
// app context and this suite is about the session, not caching.
vi.mock("@pinia/colada", () => ({
  useQueryCache: () => ({ cancelQueries: () => {}, remove: () => {}, getEntries: () => [] }),
}));

const getSession = vi.fn();
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

const { installSessionRescope, reportSessionRescoped, setSessionRescope } =
  await import("./session-rescope");
const { useAuthStore } = await import("~/stores/auth");
const { useAuth } = await import("~/composables/useAuth");

/** A resolved Better Auth session for `who`. */
function session(id: string, role: "user" | "admin" = "user") {
  return { data: { user: { id, name: `${id}-name`, email: `${id}@x.test`, role } }, error: null };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  setSessionRescope(null);
});

describe("the installed rescope handler", () => {
  it("re-reads a session the app had already checked", async () => {
    // THE FAILURE: the tab has checked once, so `checked` is set and the role
    // it holds is the pre-promotion one. Anything built on check() stops here.
    getSession.mockResolvedValueOnce(session("alice", "user"));
    await useAuth().check();
    const store = useAuthStore();
    expect(store.admin).toBe(false);

    getSession.mockResolvedValueOnce(session("alice", "admin"));
    installSessionRescope();
    await reportSessionRescoped();

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(store.admin).toBe(true);
  });

  it("renames the tab when the cookie now resolves to somebody else", async () => {
    getSession.mockResolvedValueOnce(session("alice"));
    await useAuth().check();

    getSession.mockResolvedValueOnce(session("bob"));
    installSessionRescope();
    await reportSessionRescoped();

    const store = useAuthStore();
    expect(store.userId).toBe("bob");
    expect(store.name).toBe("bob-name");
  });

  it("clears the app's session when the refresh finds nobody", async () => {
    getSession.mockResolvedValueOnce(session("alice"));
    await useAuth().check();

    getSession.mockResolvedValueOnce({ data: null, error: null });
    installSessionRescope();
    await reportSessionRescoped();

    const store = useAuthStore();
    expect(store.authenticated).toBe(false);
    expect(store.userId).toBeNull();
  });
});

describe("the report seam", () => {
  it("resolves immediately when nothing is installed", async () => {
    // The plugin sequences its re-dial behind this. With no handler — a test
    // harness, or a bootstrap that never installed one — it must still finish,
    // or the tab silently loses its socket.
    await expect(reportSessionRescoped()).resolves.toBeUndefined();
  });

  it("shares one refresh between reports that overlap", async () => {
    let release: () => void = () => {};
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    setSessionRescope(handler);

    const first = reportSessionRescoped();
    const second = reportSessionRescoped();
    expect(first).toBe(second);

    release();
    await first;

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stays usable after a refresh that threw", async () => {
    // A network error during the refresh must not latch the seam shut: the
    // next re-scope is the app's only remaining chance to catch up.
    setSessionRescope(async () => {
      throw new Error("offline");
    });
    await expect(reportSessionRescoped()).resolves.toBeUndefined();

    const second = vi.fn(async () => {});
    setSessionRescope(second);
    await reportSessionRescoped();

    expect(second).toHaveBeenCalledTimes(1);
  });
});
