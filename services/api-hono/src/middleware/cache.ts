import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";

/**
 * Route-level caching middleware backed by KVStore.
 * Replaces Nitro's `defineCachedHandler`.
 *
 * Cache keys include the authenticated user's userId (when present)
 * to prevent cross-user data leakage.
 */
export function cachedRoute(opts: { maxAge: number }) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    // Skip caching when userId is missing to prevent cross-user cache sharing
    const userId = c.get("userId");
    if (!userId) {
      await next();
      return;
    }

    const cacheStorage = c.get("cacheStorage");
    const url = new URL(c.req.url);
    // Encode query params as a path segment to preserve them in cache keys
    const search = url.search ? `:${url.search.slice(1)}` : "";
    // Include userId in cache key to scope per-user
    const userScope = c.get("userId") ? `:user:${c.get("userId")}` : "";
    const cacheKey = `routes:${url.pathname}${search}${userScope}`;

    try {
      const cached = (await cacheStorage.getItem(cacheKey)) as {
        body: string;
        headers: Record<string, string>;
        status: number;
      } | null;

      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: { ...cached.headers, "x-cache": "HIT" },
        });
      }
    } catch {
      // Cache miss or error — proceed normally
    }

    await next();

    // Only cache successful responses
    if (c.res.status >= 200 && c.res.status < 300) {
      try {
        const clone = c.res.clone();
        const body = await clone.text();
        const headers: Record<string, string> = {};
        clone.headers.forEach((v, k) => {
          headers[k] = v;
        });
        await cacheStorage.setItem(
          cacheKey,
          { body, headers, status: clone.status },
          { ttl: opts.maxAge },
        );
      } catch {
        // Cache write failure — non-fatal
      }
    }

    // Inject x-cache: MISS by replacing the response with a new one
    const original = c.res;
    const newHeaders = new Headers(original.headers);
    newHeaders.set("x-cache", "MISS");
    c.res = new Response(original.body, {
      status: original.status,
      statusText: original.statusText,
      headers: newHeaders,
    });
  });
}
