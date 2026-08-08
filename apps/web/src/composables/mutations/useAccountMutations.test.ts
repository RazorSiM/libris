// @vitest-environment happy-dom
/**
 * What has to be re-read after you act on your own account (libris-59m.40).
 *
 * Both mutations here change something the UI is already rendering, and neither
 * response carries the new value:
 *
 * - updateUser answers `{ status: true }`, so the sidebar and the settings
 *   badge keep the old name until the session is read again;
 * - changePassword rotates the current session's token and, with
 *   revokeOtherSessions, deletes every other session — while the device list
 *   sits on screen directly below the form, still offering "Sign out" buttons
 *   for devices that are already out.
 *
 * These assert the invalidation, not the request, because the invalidation is
 * the part that was missing.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface MutationOptions {
  mutation: (vars: unknown) => Promise<unknown>;
  onSuccess?: () => unknown;
  onSettled?: () => unknown;
}

const invalidateQueries = vi.fn();
const captured: MutationOptions[] = [];

vi.mock("@pinia/colada", () => ({
  useMutation: (options: MutationOptions) => {
    captured.push(options);
    return { mutateAsync: options.mutation };
  },
  // useSessionMutations is imported for its key and pulls this in with it.
  useQuery: () => ({ data: { value: [] } }),
  useQueryCache: () => ({ invalidateQueries }),
}));

const changePassword = vi.fn();
const updateUser = vi.fn();
vi.mock("~/lib/auth-client", () => ({
  authClient: {
    changePassword: (...args: unknown[]) => changePassword(...args),
    updateUser: (...args: unknown[]) => updateUser(...args),
  },
  unwrapAuthResult: (result: { data: unknown }) => result.data,
}));

const refresh = vi.fn();
Object.assign(globalThis, { useAuth: () => ({ refresh }) });

const { useChangePassword, useUpdateProfile } = await import("./useAccountMutations");
const { SESSIONS_KEY } = await import("./useSessionMutations");

/** The options the composable handed useMutation. */
function optionsOf(composable: () => unknown): MutationOptions {
  captured.length = 0;
  composable();
  const options = captured[0];
  if (!options) throw new Error("useMutation was never called");
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  changePassword.mockResolvedValue({ data: { status: true } });
  updateUser.mockResolvedValue({ data: { status: true } });
});

describe("useChangePassword()", () => {
  it("invalidates the device list once the change settles", async () => {
    // Without this the card below the form still lists the phone and the work
    // laptop as signed in, with live Sign out buttons that then fail against a
    // token that no longer exists — and the user cannot tell whether the
    // revocation worked.
    const options = optionsOf(useChangePassword);

    await options.mutation({
      currentPassword: "old",
      newPassword: "new",
      revokeOtherSessions: true,
    });
    await options.onSettled?.();

    expect(invalidateQueries).toHaveBeenCalledWith({ key: SESSIONS_KEY });
  });

  it("invalidates on the key the sessions query actually caches under", () => {
    // The literal used to be written out twice. Two spellings of the same key
    // invalidate nothing, and the failure is silent.
    optionsOf(useChangePassword).onSettled?.();

    expect(invalidateQueries).toHaveBeenCalledWith({ key: ["account", "sessions"] });
    expect(SESSIONS_KEY).toEqual(["account", "sessions"]);
  });

  it("invalidates even when the change fails", () => {
    // onSettled, not onSuccess: a change that errors after the server committed
    // leaves exactly the same stale list.
    const options = optionsOf(useChangePassword);
    expect(options.onSettled).toBeTypeOf("function");
  });
});

describe("useUpdateProfile()", () => {
  it("re-reads the session so the chrome shows the new name", async () => {
    const options = optionsOf(useUpdateProfile);

    await options.mutation({ name: "Grace Hopper" });
    await options.onSuccess?.();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
