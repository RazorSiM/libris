/**
 * The one place the app records that IT is replacing its own credential.
 *
 * The third of the small seams around the session — `session-invalidation.ts`
 * handles "the server refused this credential", `session-rescope.ts` handles
 * "this credential is fine but what the app believes about it is stale", and
 * this one handles the case neither of those can read correctly on its own:
 * the tab deliberately swapping its own session token for a new one.
 *
 * WHY IT HAS TO EXIST (password change):
 *
 * `POST /api/auth/change-password` with `revokeOtherSessions` is implemented in
 * Better Auth (1.6.25, `dist/api/routes/update-user.mjs`) as revoke-ALL then
 * re-issue-mine:
 *
 *     await ctx.context.internalAdapter.deleteUserSessions(session.user.id);
 *     const newSession = await ctx.context.internalAdapter.createSession(...);
 *     await setSessionCookie(ctx, { session: newSession, user: session.user });
 *
 * The caller's own session row is deleted along with everybody else's, which
 * fires the `session.delete` database hooks in the API's `lib/auth.ts` — so the
 * server closes THIS tab's event socket with 4401 ("the credential behind this
 * socket is gone"). That reading is true of the row and false of the user: the
 * very same response carries a fresh cookie.
 *
 * The server cannot tell the two apart for us. At hook time a delete is a
 * delete, and only the client knows which cookie it is actually holding. Nor
 * can the client find out by asking: the close frame is written during the
 * after-hook drain, BEFORE the HTTP response is returned (`runWithAdapter` in
 * `dist/auth/base.mjs` awaits the handler and only then runs the queued hooks),
 * so a session probe fired from the close handler goes out carrying the OLD
 * cookie and is answered, correctly, with "no session". Every evidence-based
 * check races the rotation it is trying to observe.
 *
 * What is NOT ambiguous is causation: the tab asked for this. So the mutation
 * that rotates the credential says so here, and the socket plugin waits for the
 * new cookie to land before it decides what the 4401 meant.
 *
 * FAIL-SAFE DIRECTION. A rotation that forgets to register here produces a
 * spurious sign-out — visible, annoying, harmless. Nothing here can cause a
 * genuine revocation to be ignored beyond the window of a request the tab
 * itself issued.
 */

/**
 * How long after a rotation completes a 4401 is still read as its aftermath.
 *
 * Belt and braces, not the mechanism. The close frame is written before the
 * response, so the rotation is still in flight when the close lands and
 * `pending` alone answers the question. This covers the pathological ordering
 * where the browser dispatches the fetch resolution first, and it is short
 * enough that a genuine revocation arriving inside it is still resolved
 * correctly — the plugin refreshes the session, finds nothing, and stops.
 */
export const SESSION_ROTATION_GRACE_MS = 2000;

/** The rotation currently on the wire, resolving to whether it succeeded. */
let pending: Promise<boolean> | null = null;
/** When the last SUCCESSFUL rotation settled. A failed one rotates nothing. */
let succeededAt = 0;

/**
 * Declare that `work` replaces this tab's session token.
 *
 * Call it with the request already started — the whole point is that the marker
 * is set before the server can answer. Returns `work` untouched, so it drops
 * into a mutation without changing its result or its error.
 */
export function trackSessionRotation<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    () => {
      succeededAt = Date.now();
      return true;
    },
    () => false,
  );
  pending = settled;
  void settled.finally(() => {
    // Only if it is still ours: a second rotation started meanwhile owns the
    // slot, and clearing it would make the next caller think nothing is running.
    if (pending === settled) pending = null;
  });
  return work;
}

/** Whether this tab is replacing its own credential right now, or just did. */
export function isRotatingSession(): boolean {
  return pending !== null || Date.now() - succeededAt < SESSION_ROTATION_GRACE_MS;
}

/**
 * Resolve once the rotation has settled, to whether it actually replaced the
 * credential.
 *
 * `false` means there is no new cookie to wait for — the change was refused, or
 * nothing was rotating in the first place — and the caller should treat whatever
 * prompted the wait at face value.
 */
export function sessionRotationSettled(): Promise<boolean> {
  if (pending) return pending;
  return Promise.resolve(Date.now() - succeededAt < SESSION_ROTATION_GRACE_MS);
}

/** Forget everything. Tests and teardown only. */
export function resetSessionRotation(): void {
  pending = null;
  succeededAt = 0;
}
