import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { authClient, unwrapAuthResult as unwrap } from "~/lib/auth-client";

/**
 * Admin user management, over the Better Auth admin plugin.
 *
 * This is the only place besides useAuth() that talks to authClient, and it is
 * deliberate: these endpoints have no Hono RPC types (the handler is mounted as
 * a catch-all), so the alternative is untyped fetch calls scattered through a
 * component.
 *
 * Every mutation here is gated twice — the plugin refuses a non-admin caller,
 * and the UI never renders the panel for one. The plugin's refusal is the one
 * that matters; the UI is courtesy.
 */

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role?: string | null | undefined;
  banned?: boolean | null | undefined;
  createdAt: Date | string;
}

const USERS_KEY = ["admin", "users"];

export function useUsersQuery() {
  const { isAdmin } = useAuth();

  return useQuery({
    key: USERS_KEY,
    query: async () => {
      const data = unwrap(
        await authClient.admin.listUsers({ query: { limit: 200, sortBy: "createdAt" } }),
      );
      return (data as { users: ManagedUser[] }).users;
    },
    // Never fire for a non-admin: the request would 403 and the error would
    // surface as a broken page rather than a hidden feature.
    enabled: () => isAdmin.value,
    staleTime: 10_000,
  });
}

export function useCreateUser() {
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: {
      email: string;
      password: string;
      name: string;
      role: "user" | "admin";
    }) => unwrap(await authClient.admin.createUser(vars)),
    onSettled: () => queryCache.invalidateQueries({ key: USERS_KEY }),
  });
}

export function useSetUserRole() {
  const queryCache = useQueryCache();

  return useMutation({
    // Better Auth refreshes the affected user's session itself, so a promotion
    // takes effect on their very next request rather than at their next
    // sign-in. Pinned by "reflects a promotion made through the admin plugin"
    // in middleware/auth.test.ts — if that ever regresses, the UI would be
    // reporting a change that has not happened.
    mutation: async (vars: { userId: string; role: "user" | "admin" }) =>
      unwrap(await authClient.admin.setRole(vars)),
    onSettled: () => queryCache.invalidateQueries({ key: USERS_KEY }),
  });
}

export function useBanUser() {
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (vars: { userId: string; ban: boolean }) =>
      vars.ban
        ? unwrap(await authClient.admin.banUser({ userId: vars.userId }))
        : unwrap(await authClient.admin.unbanUser({ userId: vars.userId })),
    onSettled: () => queryCache.invalidateQueries({ key: USERS_KEY }),
  });
}

/**
 * Set someone's password for them.
 *
 * This is the whole account-recovery story: there is no mail transport, so a
 * forgotten password is fixed by an admin here and told to the user out of
 * band. The server revokes every browser session after the password changes;
 * app passwords remain active as separately managed device credentials.
 */
export function useSetUserPassword() {
  return useMutation({
    mutation: async (vars: { userId: string; newPassword: string }) =>
      unwrap(await authClient.admin.setUserPassword(vars)),
  });
}

export function useRemoveUser() {
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (userId: string) => unwrap(await authClient.admin.removeUser({ userId })),
    onSettled: () => queryCache.invalidateQueries({ key: USERS_KEY }),
  });
}
