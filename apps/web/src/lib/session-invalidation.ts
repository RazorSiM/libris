/**
 * The one place the app is told that the server no longer honours its session.
 *
 * A 401 can arrive from either transport — the Hono RPC client in
 * useApiClient(), or the Better Auth client — and neither can do anything about
 * it on its own: one is a bare fetch wrapper, the other a module-scope
 * singleton, and clearing the auth store and navigating needs a store and a
 * router. So they report here, and the recovery itself is installed once, by
 * installSessionRecovery() in router/guards.ts, which has both.
 *
 * Without this the tab is wedged. check() short-circuits on `checked` for the
 * rest of the page's life, so a session killed on the server — a ban, a revoke
 * from another device, an admin setting your password, plain expiry — leaves
 * the guard letting every navigation through while every query 401s into a
 * "Something went wrong" toast, and the user is never sent anywhere they can
 * fix it.
 */

type Recovery = () => void | Promise<void>;

let recovery: Recovery | null = null;
let running: Promise<void> | null = null;

/** Install the recovery. Passing null removes it (tests, teardown). */
export function setSessionRecovery(handler: Recovery | null): void {
  recovery = handler;
  running = null;
}

/**
 * Report that a credential the app believed in was refused.
 *
 * Callable from anywhere, any number of times: recoveries do not stack, so a
 * page that fires six queries and collects six 401s still signs out and
 * redirects once rather than six times.
 */
export function reportSessionInvalidated(): void {
  const handler = recovery;
  if (!handler || running) return;

  running = (async () => {
    try {
      await handler();
    } catch {
      // A recovery that fails (a cancelled navigation, say) must not leave the
      // gate latched shut against the next 401.
    }
  })().finally(() => {
    running = null;
  });
}
