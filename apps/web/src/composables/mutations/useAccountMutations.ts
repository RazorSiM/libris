import { useMutation } from "@pinia/colada";
import { authClient, unwrapAuthResult } from "~/lib/auth-client";

/**
 * The signed-in person acting on their own account.
 *
 * Both endpoints read the caller's session and take no user id, which is what
 * separates this from useUserMutations — there an admin acts on somebody else,
 * and the plugin checks the role. Here there is nothing to check: you are
 * always allowed to change your own name and, given the current password, your
 * own password.
 *
 * Like useUserMutations, this reaches authClient directly. The Better Auth
 * handler is mounted as a catch-all, so these paths contribute nothing to
 * Hono's RPC type graph and the alternative is an untyped fetch in a component.
 */

/** Rename yourself. Better Auth refuses `email` outright, so it is not offered. */
export function useUpdateProfile() {
  const { refresh } = useAuth();

  return useMutation({
    mutation: async (vars: { name: string }) => unwrapAuthResult(await authClient.updateUser(vars)),
    // The response is a bare `{ status: true }` — the new name is not in it, so
    // the sidebar and the settings badge keep showing the old one until the
    // session is read again.
    onSuccess: () => refresh(),
  });
}

export interface ChangePasswordVars {
  currentPassword: string;
  newPassword: string;
  /**
   * Ends every other session and issues this browser a fresh one.
   *
   * Better Auth deletes ALL of the user's sessions and then re-creates the
   * current one, so the caller stays signed in on a new cookie. App passwords
   * are untouched: they are separate credentials with their own revocation, and
   * a password change that silently unpaired every e-reader in the house would
   * be a worse surprise than one that does not.
   */
  revokeOtherSessions: boolean;
}

export function useChangePassword() {
  return useMutation({
    mutation: async (vars: ChangePasswordVars) =>
      unwrapAuthResult(await authClient.changePassword(vars)),
  });
}
