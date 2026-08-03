// @vitest-environment happy-dom
/**
 * useAuth() over the Better Auth client.
 *
 * A dozen call sites depend on this surface. These pin the behaviours that are
 * cheap to break and expensive to lose in production:
 *
 * - the generation counter, which stops a check() that was already in flight
 *   from re-authenticating the app after logout. This regressed once before,
 *   on 2026-04-11, and the symptom was a user watching themselves get signed
 *   back in;
 * - the single-flight promise, so a page mounting five components does one
 *   session request rather than five;
 * - refresh(), which is the only way to see your own edits to the session.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { computed, ref } from "vue";

// The composable reaches for @pinia/colada's query cache; a real one needs a
// full app context, and this suite is about auth state, not caching.
const cancelQueries = vi.fn();
const remove = vi.fn();
vi.mock("@pinia/colada", () => ({
  useQueryCache: () => ({ cancelQueries, remove, getEntries: () => [] }),
  useMutation: (options: { mutation: (...args: unknown[]) => unknown }) => ({
    mutateAsync: options.mutation,
  }),
}));

const signInEmail = vi.fn();
const signOut = vi.fn();
const getSession = vi.fn();
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    signIn: { email: (...args: unknown[]) => signInEmail(...args) },
    signOut: (...args: unknown[]) => signOut(...args),
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

Object.assign(globalThis, { ref, computed });

const { useAuth } = await import("./useAuth");

/** A resolved Better Auth session for `who`. */
function session(id: string, role: "user" | "admin" = "user") {
  return { data: { user: { id, name: `${id}-name`, email: `${id}@x.test`, role } }, error: null };
}

/** What the client returns when nobody is signed in. */
const anonymous = { data: null, error: null };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  getSession.mockResolvedValue(anonymous);
  signInEmail.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  signOut.mockResolvedValue({ data: { success: true }, error: null });
});

describe("check()", () => {
  it("populates state from the session", async () => {
    getSession.mockResolvedValue(session("u1", "admin"));
    const auth = useAuth();

    await auth.check();

    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.isAdmin.value).toBe(true);
    expect(auth.userId.value).toBe("u1");
    expect(auth.userName.value).toBe("u1-name");
    expect(auth.userEmail.value).toBe("u1@x.test");
    expect(auth.userLabel.value).toBe("u1-name");
  });

  it("falls back to the email address when the account has no name", async () => {
    // The account page can clear a name down to nothing server-side; the
    // sidebar must still have something to render.
    getSession.mockResolvedValue({
      data: { user: { id: "u1", name: null, email: "u1@x.test", role: "user" } },
      error: null,
    });
    const auth = useAuth();

    await auth.check();

    expect(auth.userLabel.value).toBe("u1@x.test");
  });

  it("treats a null session as signed out rather than an error", async () => {
    const auth = useAuth();
    await auth.check();

    expect(auth.isAuthenticated.value).toBe(false);
    expect(auth.checked.value).toBe(true);
  });

  it("survives the client throwing", async () => {
    getSession.mockRejectedValue(new Error("network down"));
    const auth = useAuth();

    await auth.check();

    expect(auth.isAuthenticated.value).toBe(false);
    expect(auth.checked.value).toBe(true);
  });

  it("shares one request between concurrent callers", async () => {
    // A page mounting several components must not fire several session
    // requests. Without the single-flight promise this is five.
    const auth = useAuth();
    await Promise.all([auth.check(), auth.check(), auth.check()]);

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the session has already been resolved", async () => {
    const auth = useAuth();
    await auth.check();
    await auth.check();

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe("refresh()", () => {
  it("re-reads a session that check() has already cached", async () => {
    // Renaming yourself changes the session's contents without changing who is
    // signed in. check() short-circuits on `checked`, so without refresh() the
    // sidebar keeps rendering the old name until a full page load.
    getSession.mockResolvedValue(session("u1"));
    const auth = useAuth();
    await auth.check();
    expect(auth.userName.value).toBe("u1-name");

    getSession.mockResolvedValue({
      data: { user: { id: "u1", name: "Renamed", email: "u1@x.test", role: "user" } },
      error: null,
    });
    await auth.refresh();

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(auth.userName.value).toBe("Renamed");
  });
});

describe("logout()", () => {
  it("does not let an in-flight check() sign the user back in", async () => {
    // THE RACE: check() reads the session, logout() happens while that request
    // is still open, then the stale response lands and repopulates state. The
    // user watches themselves get logged back in. The generation counter is
    // what makes the late response a no-op.
    let resolveSession!: (value: unknown) => void;
    getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    const auth = useAuth();
    const inFlight = auth.check();

    await auth.logout();
    expect(auth.isAuthenticated.value).toBe(false);

    resolveSession(session("u1"));
    await inFlight;

    expect(auth.isAuthenticated.value).toBe(false);
    expect(auth.userId.value).toBeNull();
  });

  it("clears the query cache so the next user sees no stale data", async () => {
    const auth = useAuth();
    await auth.logout();

    expect(signOut).toHaveBeenCalled();
    expect(cancelQueries).toHaveBeenCalled();
  });
});

describe("login()", () => {
  it("signs in with email and password, then resolves the session", async () => {
    getSession.mockResolvedValue(session("u1"));
    const auth = useAuth();

    await auth.login("reader@example.test", "correct-horse-battery-staple");

    expect(signInEmail).toHaveBeenCalledWith({
      email: "reader@example.test",
      password: "correct-horse-battery-staple",
    });
    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.userId.value).toBe("u1");
  });

  it("clears the query cache so the previous user's data is not reused", async () => {
    const auth = useAuth();
    await auth.login("reader@example.test", "pw");

    expect(cancelQueries).toHaveBeenCalled();
  });

  it("surfaces bad credentials as an error the login page can show", async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: "Invalid email or password" } });
    const auth = useAuth();

    await expect(auth.login("reader@example.test", "wrong")).rejects.toThrow(/invalid/i);
    expect(auth.isAuthenticated.value).toBe(false);
  });

  it("distinguishes a network failure from a rejected password", async () => {
    // The login page tells the user to check their password in one case and to
    // try again in the other; collapsing them sends people chasing the wrong
    // problem.
    signInEmail.mockRejectedValue(new Error("fetch failed"));
    const auth = useAuth();

    await expect(auth.login("reader@example.test", "pw")).rejects.toThrow(/network/i);
  });
});
