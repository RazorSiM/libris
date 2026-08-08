/**
 * The one place the app is told its socket's SCOPE went stale.
 *
 * The sibling of `session-invalidation.ts`, and deliberately shaped like it.
 * That module handles the verdict "this credential is gone"; this one handles
 * "this credential is fine, but what the app believes about it is out of date"
 * — the server's 4409, sent when the session behind an open event
 * socket comes back with a different role, or a different person.
 *
 * The server rebinds the new socket's scope by itself: `isAdmin(c)` and the
 * user id are read from the current session at upgrade. Nothing rebinds the
 * SPA. Without this a promoted user got an admin-scoped event feed behind a
 * sidebar with no admin navigation, and an identity change left the store
 * naming the previous user for the life of the tab — check() short-circuits on
 * `checked` after the first call, so nothing was ever going to ask again.
 *
 * Why a seam rather than the plugin importing useAuth() directly: the plugin
 * owns the wire, not the policy. What a re-scope MEANS to the app is the same
 * kind of decision as what a 401 means, and that one is already installed from
 * router/guards.ts rather than reached for from the transport. It also keeps
 * useAuth() — and therefore @pinia/colada's query cache — out of a module that
 * runs before any of it is guaranteed to exist.
 */

import { useAuth } from "~/composables/useAuth";

type Rescope = () => void | Promise<void>;

let rescope: Rescope | null = null;
let running: Promise<void> | null = null;

/** Install the handler. Passing null removes it (tests, teardown). */
export function setSessionRescope(handler: Rescope | null): void {
  rescope = handler;
  running = null;
}

/**
 * Report that this socket's scope is stale, and resolve once the app agrees
 * with the server again.
 *
 * AWAITABLE, unlike `reportSessionInvalidated()`, because the caller has a
 * decision waiting on the answer: the re-dial must carry the new scope, and
 * whether the plugin dials at all depends on what the refreshed session says.
 *
 * Concurrent reports share the one refresh rather than stacking: a re-scope
 * that races a reconnect would otherwise fire a session request per close.
 * With no handler installed this resolves immediately, so a caller that
 * sequences work behind it still makes progress.
 */
export function reportSessionRescoped(): Promise<void> {
  const handler = rescope;
  if (!handler) return Promise.resolve();
  if (running) return running;

  running = (async () => {
    try {
      await handler();
    } catch {
      // A refresh that fails must not latch the gate shut against the next
      // re-scope. The caller decides what to do with an unchanged store.
    }
  })().finally(() => {
    running = null;
  });

  return running;
}

/**
 * What the app does when the server re-scopes a socket.
 *
 * refresh() rather than check(): check() is a once-per-load cache and would
 * return the stale copy this exists to get past. refresh() goes through
 * beginNewSession(), which is the single funnel for an identity change
 * — it bumps the generation so a session request issued under
 * the previous identity cannot land on top of this one.
 *
 * Installed from installRouterGuards(), beside installSessionRecovery().
 */
export function installSessionRescope(): void {
  setSessionRescope(async () => {
    await useAuth().refresh();
  });
}
