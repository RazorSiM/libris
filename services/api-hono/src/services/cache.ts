import type { KVStore } from "./kv-store.js";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("cache");

/**
 * The only path roots `cachedRoute` is mounted under (libris-kej).
 *
 * Every cached entry's key is `routes:<pathname>[:<query>][:user:<id>]`, so a
 * prefix can only match something if a `cachedRoute` mount lives under it.
 * Before this list existed, every call site invalidated `/api/library`,
 * `/api/inbox`, `/api/settings` or `/api/books/{id}/candidates` — none of which
 * is cached — while `/opds`, which is, was never invalidated by anything. The
 * two lists were disjoint, so approving or editing a book left an e-reader
 * refreshing its catalogue on a stale feed until the entry's TTL ran out.
 *
 * Keep it in sync with the mounts: `cache-invalidation.test.ts` derives the real
 * mount list from the assembled router and fails if the two disagree in either
 * direction.
 */
export const CACHED_ROUTE_PREFIXES = ["/opds", "/api/stats"] as const;

type CachedRoot = (typeof CACHED_ROUTE_PREFIXES)[number];

/**
 * A path prefix that can actually match a cached key — a cached root, or
 * anything below one (`/opds/books/{id}`).
 *
 * This is the compile-time half of the guard: passing `/api/library` to
 * {@link invalidateRouteCache} is now a type error rather than a call that
 * quietly does nothing.
 */
export type CachedRoutePrefix = CachedRoot | `${CachedRoot}/${string}`;

/** Runtime form of {@link CachedRoutePrefix}, for tests and dynamic callers. */
export function isCachedRoutePrefix(prefix: string): prefix is CachedRoutePrefix {
  return CACHED_ROUTE_PREFIXES.some((root) => prefix === root || prefix.startsWith(`${root}/`));
}

/**
 * How long to wait before retrying invalidations a KV outage deferred.
 *
 * Short enough that recovery is prompt on an idle install, long enough that a
 * multi-minute outage costs a handful of failing SCANs rather than a busy loop.
 */
const RETRY_INTERVAL_MS = 5_000;

/**
 * Ceiling on deferred prefixes per store.
 *
 * Prefixes are not a fixed set — `/api/books/{id}/candidates` is per book — so
 * an outage during a bulk import could otherwise grow this without bound. Past
 * the cap the oldest entry is dropped and falls back to the TTL backstop below.
 */
const MAX_PENDING_PREFIXES = 256;

interface PendingState {
  /** Prefixes whose invalidation failed, oldest first (Set keeps insertion order). */
  prefixes: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

// Keyed by store so a test's throwaway store cannot leak state into the next
// test, and so the state disappears with the store rather than living forever.
const pendingByStore = new WeakMap<KVStore, PendingState>();

function pendingFor(cacheStorage: KVStore): PendingState {
  let state = pendingByStore.get(cacheStorage);
  if (!state) {
    state = { prefixes: new Set(), timer: null };
    pendingByStore.set(cacheStorage, state);
  }
  return state;
}

function takePending(state: PendingState): Set<string> {
  const taken = new Set(state.prefixes);
  state.prefixes.clear();
  return taken;
}

function scheduleRetry(cacheStorage: KVStore, state: PendingState): void {
  if (state.timer) return;
  const timer = setTimeout(() => {
    state.timer = null;
    void drain(cacheStorage, state, takePending(state));
  }, RETRY_INTERVAL_MS);
  // Never hold the process open for a cache chore.
  timer.unref?.();
  state.timer = timer;
}

function defer(cacheStorage: KVStore, state: PendingState, failed: string[], err: unknown): void {
  for (const prefix of failed) {
    // Delete-then-add moves a repeat offender to the back, so the cap evicts
    // the prefix that has been waiting longest without progress.
    state.prefixes.delete(prefix);
    state.prefixes.add(prefix);
  }

  while (state.prefixes.size > MAX_PENDING_PREFIXES) {
    const oldest = state.prefixes.values().next().value;
    if (oldest === undefined) break;
    state.prefixes.delete(oldest);
    logger
      .withMetadata({ prefix: oldest })
      .warn(
        "Too many deferred cache invalidations; dropping the oldest. Any surviving entry for it now expires on its own TTL.",
      );
  }

  logger
    .withMetadata({ prefixes: failed, pending: state.prefixes.size })
    .warn(
      `Route cache invalidation failed; the write it followed succeeded, so the invalidation is deferred rather than raised: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );

  scheduleRetry(cacheStorage, state);
}

async function drain(
  cacheStorage: KVStore,
  state: PendingState,
  targets: Set<string>,
): Promise<void> {
  const failed: string[] = [];
  let lastError: unknown;

  for (const prefix of targets) {
    try {
      const keys = await cacheStorage.getKeys(`routes:${prefix}`);
      await Promise.all(keys.map((key) => cacheStorage.removeItem(key)));
    } catch (err) {
      lastError = err;
      failed.push(prefix);
    }
  }

  if (failed.length > 0) {
    defer(cacheStorage, state, failed, lastError);
    return;
  }

  if (state.timer && state.prefixes.size === 0) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * Invalidate cached responses for routes matching the given path prefixes.
 *
 * **Never rejects** (libris-hs5). Redis is a cache in front of durable
 * Postgres, and by the time a route calls this the durable write has already
 * committed. Propagating the KV error turned a 200 into a 500 while leaving the
 * mutation applied, so every mutating route failed for the duration of a Redis
 * blip even though it had done its job. Same policy as
 * `auth-secondary-storage.ts`: a Redis failure must not fail a request.
 *
 * Unlike that module's `set`/`delete` — which stay loud because a dropped write
 * there is a revocation that silently did not happen — invalidation cannot be
 * made the caller's problem: the caller has nothing left to roll back, and a
 * stale entry that outlives the outage would serve wrong data. So it is
 * compensated instead, on two layers:
 *
 * 1. **Deferred retry.** A failed prefix is remembered per store and retried by
 *    the next `invalidateRouteCache` call on that store, and by an unref'd
 *    timer every {@link RETRY_INTERVAL_MS} so recovery does not depend on
 *    further traffic. The backlog drains on the first attempt that finds the KV
 *    store healthy again.
 * 2. **TTL backstop.** `cachedRoute` writes every entry with `ttl: maxAge`
 *    (60-120s across the mounted routes), so even a backlog lost to a process
 *    restart or to the {@link MAX_PENDING_PREFIXES} cap cannot outlive it.
 *
 * Worst case staleness is therefore the entry's remaining TTL — at most
 * `maxAge`, currently 120s — and in practice the retry wins first. Nothing new
 * is cached during the outage either, since `setItem` fails too and the
 * middleware treats a read error as a miss, so the exposure is limited to
 * entries written before the outage began.
 *
 * Prefixes are restricted to {@link CachedRoutePrefix} so a call cannot name a
 * path nothing caches (libris-kej). Over-invalidating is fine — `/opds` clears
 * the whole catalogue, which is a handful of small feed entries — but naming a
 * path that holds no entries is not, because it reads as coverage while doing
 * nothing.
 */
export async function invalidateRouteCache(
  cacheStorage: KVStore,
  ...pathPrefixes: CachedRoutePrefix[]
): Promise<void> {
  const state = pendingFor(cacheStorage);
  // A caller that finds the store healthy again is the cheapest recovery
  // trigger there is, so retry the backlog alongside the new work.
  const targets = takePending(state);
  for (const prefix of pathPrefixes) targets.add(prefix);

  await drain(cacheStorage, state, targets);
}

/** Prefixes still waiting on a healthy KV store, oldest first. Exposed for tests. */
export function getDeferredInvalidations(cacheStorage: KVStore): string[] {
  return [...(pendingByStore.get(cacheStorage)?.prefixes ?? [])];
}

/** Drop the deferred backlog for a store. Exposed for tests. */
export function resetDeferredInvalidations(cacheStorage: KVStore): void {
  const state = pendingByStore.get(cacheStorage);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  pendingByStore.delete(cacheStorage);
}
