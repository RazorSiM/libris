/**
 * Per-user cache of the Hardcover connection status.
 *
 * `GET /api/hardcover/status` verifies the stored token with a live GraphQL
 * call, so an unauthenticated loop of requests turns into an unbounded stream
 * of outbound calls on the user's token. The route caches its own response
 * here for a short window instead.
 */
export const HARDCOVER_STATUS_CACHE_TTL_SECONDS = 30;

export function hardcoverStatusCacheKey(userId: string): string {
  return `hardcover:status:${userId}`;
}
