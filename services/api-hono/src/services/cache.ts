import type { KVStore } from "./kv-store.js";

/**
 * Invalidate cached responses for routes matching the given path prefixes.
 * Accepts a KVStore instance instead of using Nitro's useStorage.
 */
export async function invalidateRouteCache(
  cacheStorage: KVStore,
  ...pathPrefixes: string[]
): Promise<void> {
  for (const prefix of pathPrefixes) {
    const keys = await cacheStorage.getKeys(`routes:${prefix}`);
    await Promise.all(keys.map((key) => cacheStorage.removeItem(key)));
  }
}
