import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { authClient, unwrapAuthResult } from "~/lib/auth-client";

/**
 * The browsers and devices signed in to this account.
 *
 * Everything goes through the Better Auth API rather than a Drizzle query, and
 * that is not a style preference. With secondaryStorage configured, Redis is
 * where a session's liveness actually lives: getSession never reads the
 * sessions table, so `DELETE FROM sessions` would strike a row out of the list
 * while the device carried on working until its TTL lapsed — signed out in the
 * UI, signed in in reality. listSessions reads the same store getSession does,
 * and revokeSession clears both.
 */

const SESSIONS_KEY = ["account", "sessions"];

interface ListedSession {
  id: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface DeviceSession extends ListedSession {
  /** Whether this row is the browser doing the asking. */
  isCurrent: boolean;
}

/**
 * Every session on the account, with the caller's own marked.
 *
 * Better Auth does not flag the current one, so it is resolved here by
 * comparing tokens. Doing it in the query rather than the component means the
 * current session's token is compared and discarded in one place, instead of
 * being handed to a template that only ever needed a boolean.
 *
 * A session token is the value of the cookie that authenticates that device.
 * Never render one — not as text, not in an attribute, not in a testid. Rows
 * are keyed by `id` for exactly that reason.
 */
export function useSessionsQuery() {
  const { isAuthenticated } = useAuth();

  return useQuery({
    key: SESSIONS_KEY,
    query: async (): Promise<DeviceSession[]> => {
      const [listed, current] = await Promise.all([
        authClient.listSessions(),
        authClient.getSession(),
      ]);
      const currentToken = current.data?.session?.token;
      return (unwrapAuthResult(listed) as ListedSession[])
        .map((session) => ({ ...session, isCurrent: session.token === currentToken }))
        .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    },
    enabled: () => isAuthenticated.value,
    // No staleTime. A device revoked from somewhere else must not still be
    // listed as signed in, and this list is small and read rarely.
    staleTime: 0,
  });
}

export function useRevokeSession() {
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async (token: string) => unwrapAuthResult(await authClient.revokeSession({ token })),
    onSettled: () => queryCache.invalidateQueries({ key: SESSIONS_KEY }),
  });
}

export function useRevokeOtherSessions() {
  const queryCache = useQueryCache();

  return useMutation({
    mutation: async () => unwrapAuthResult(await authClient.revokeOtherSessions()),
    onSettled: () => queryCache.invalidateQueries({ key: SESSIONS_KEY }),
  });
}
