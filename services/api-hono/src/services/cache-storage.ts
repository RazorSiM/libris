import { getEnv } from "../env.js";
import { createMemoryKVStore, createRedisKVStore, type KVStore } from "./kv-store.js";
import { getRequestRedis } from "./redis.js";

/**
 * Redis key prefix the route cache lives under.
 *
 * The one thing every process that touches the route cache has to agree on. A
 * worker that invalidates `cache:routes:/opds…` while the HTTP server serves
 * `routes:/opds…` would be a no-op that reads as coverage, which is the exact
 * shape of the route/cache mismatch this prefix exists to prevent.
 */
export const CACHE_KEY_PREFIX = "cache";

/**
 * Build the route-cache store for this process.
 *
 * Same dev/test split as every other KV store: an in-memory Map when there is
 * no Redis worth talking to, the shared request-path connection otherwise (no
 * extra connection).
 */
export function createCacheStorage(): KVStore {
  const env = getEnv();
  if (env.NODE_ENV === "development" || env.NODE_ENV === "test") return createMemoryKVStore();
  return createRedisKVStore(getRequestRedis(), CACHE_KEY_PREFIX);
}

let _cacheStorage: KVStore | undefined;

/**
 * The route cache, reachable without a request.
 *
 * BullMQ workers write things the cached surfaces render — `book-organize`
 * writes `coverPath` and `storagePath` AFTER approve has returned, and
 * `coverPath` is what decides whether an OPDS entry carries a cover link — but
 * a worker has no `c.get("cacheStorage")` to invalidate through, so nothing
 * did. A book approved a second ago sat in the feed without its cover until the
 * entry's 60-120s TTL ran out.
 *
 * **Why the store directly rather than an invalidation event on the bus.** The
 * event bus is Redis pub/sub, which is at-most-once and unacknowledged: an
 * invalidation published while the API process is restarting is simply lost,
 * and nothing in `invalidateRouteCache`'s deferred-retry machinery
 * spans the hop — the publisher believes it succeeded, and the subscriber that
 * would have retried never saw it. It would also have to travel on a channel
 * the SPA cannot see: `onServerEvent` fans every message out to WebSocket
 * subscribers, so a `cache:invalidate` on the existing channel would be pushed
 * to every browser as an event type they have no meaning for.
 *
 * The store is the more direct answer *and* the more portable one. The cache is
 * a shared Redis keyspace in production, not a process-local structure, so when
 * the workers move into their own process this same call resolves to the same
 * keys through that process's own connection — nothing to redo. The
 * only thing that would not survive the split is dev/test, where the store is
 * an in-memory Map per process; there the TTL backstop is the whole guarantee,
 * as it already is for anything a restart drops.
 */
export function getCacheStorage(): KVStore {
  if (!_cacheStorage) _cacheStorage = createCacheStorage();
  return _cacheStorage;
}

/**
 * Point the process-wide store at a specific store.
 *
 * Called by `bootstrap()` so the HTTP server and the in-process workers share
 * one instance — and therefore one deferred-invalidation backlog — rather than
 * two memory Maps that disagree. Also the seam tests inject through.
 */
export function setCacheStorage(store: KVStore | undefined): void {
  _cacheStorage = store;
}
