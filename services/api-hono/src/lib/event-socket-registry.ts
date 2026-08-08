import { getLogger } from "./logger.js";

const logger = getLogger("ws");

/**
 * How often an open /api/events socket re-asks the authoritative store whether
 * the credential it was upgraded with is still good (libris-e0p).
 *
 * This is the BACKSTOP, not the primary mechanism — the database hooks in
 * lib/auth.ts close a socket the instant its session row is deleted. Sixty
 * seconds is the bound on how long anything those hooks cannot see can outlive
 * its revocation:
 *
 * - a session that simply EXPIRED. Nothing deletes it; Better Auth cleans it up
 *   lazily on the next `getSession`, and an idle socket makes no requests.
 * - an app password that was disabled or deleted. Those sockets have no session
 *   row at all (the apiKey plugin synthesises one per request), so no
 *   `session.delete` hook can ever fire for them.
 * - a revocation served by ANOTHER process. The hooks are in-process; a
 *   multi-process deployment revoking on one worker cannot close a socket held
 *   by another.
 *
 * The cost is one store read per socket per minute, bounded by
 * MAX_EVENT_SOCKET_CONNECTIONS (100) to under two reads a second.
 */
export const EVENT_SOCKET_REVALIDATE_INTERVAL_MS = 60_000;

/**
 * Close code sent to a socket whose credential is no longer valid.
 *
 * 4xxx is the range RFC 6455 reserves for the application. 4401 rather than
 * 1008 so a client can tell "you are no longer authenticated" apart from a
 * generic policy refusal.
 */
export const EVENT_SOCKET_REVOKED_CLOSE_CODE = 4401;

export interface EventSocketBinding {
  /** The account the subscription was opened for. */
  userId: string;
  /**
   * The Better Auth session token, when the socket was upgraded with a browser
   * cookie.
   *
   * Null for app-password sockets. The apiKey plugin synthesises a session
   * whose `token` IS the raw key (`@better-auth/api-key`, the before-hook that
   * sets `ctx.context.session`), and that secret must not be held in a
   * long-lived map. Those sockets are covered by the user-level closes and by
   * periodic revalidation instead.
   */
  sessionToken: string | null;
  /** Tear the socket down. Must be idempotent — it can be called twice. */
  close(reason: string): void;
}

/**
 * Every open /api/events socket, indexed by the credential behind it.
 *
 * A WebSocket authenticates once, at upgrade, and then lives for as long as the
 * tab is open. Without this index, revoking the session behind one — signing out
 * elsewhere, an admin ban, an admin-set password, plain expiry — left it
 * streaming events to a principal who was no longer authenticated, while every
 * HTTP path for the same person had already stopped answering (libris-59m.6).
 *
 * Linear scan on purpose: MAX_EVENT_SOCKET_CONNECTIONS caps the set at 100 per
 * process, so two maps to keep in agreement would buy nothing and could drift.
 */
export class EventSocketRegistry {
  private readonly bindings = new Set<EventSocketBinding>();

  /** Register an open socket. Returns the deregistration function. */
  register(binding: EventSocketBinding): () => void {
    this.bindings.add(binding);
    return () => {
      this.bindings.delete(binding);
    };
  }

  /** How many sockets are currently tracked. Exposed for tests and diagnostics. */
  get size(): number {
    return this.bindings.size;
  }

  /** Close every socket upgraded with this exact session token. */
  closeForSession(sessionToken: string, reason: string): number {
    if (!sessionToken) return 0;
    return this.closeMatching(reason, (b) => b.sessionToken === sessionToken);
  }

  /**
   * Close every socket belonging to this account, whatever credential opened it.
   *
   * This is what covers app-password sockets on a ban or an account deletion:
   * they carry no session token, so nothing narrower can reach them.
   */
  closeForUser(userId: string, reason: string): number {
    if (!userId) return 0;
    return this.closeMatching(reason, (b) => b.userId === userId);
  }

  private closeMatching(reason: string, matches: (b: EventSocketBinding) => boolean): number {
    // Selected first, closed second: close() deregisters, which would otherwise
    // mutate the set while it is being iterated.
    const doomed: EventSocketBinding[] = [];
    for (const binding of this.bindings) {
      if (matches(binding)) doomed.push(binding);
    }

    for (const binding of doomed) {
      this.bindings.delete(binding);
      try {
        binding.close(reason);
      } catch (err) {
        // A socket the transport has already discarded is not a failure of the
        // revocation — the subscription is gone either way.
        logger
          .withError(err instanceof Error ? err : new Error(String(err)))
          .debug("Event socket close threw while revoking");
      }
    }
    if (doomed.length > 0) logger.info(`Closed ${doomed.length} event socket(s): ${reason}`);
    return doomed.length;
  }
}

/**
 * Process-wide, like eventSocketConnectionGuard beside it: lib/auth.ts installs
 * the revocation hooks at construction time and routes/api/events.ts registers
 * from a request, and neither has a handle on the other.
 */
export const eventSocketRegistry = new EventSocketRegistry();
