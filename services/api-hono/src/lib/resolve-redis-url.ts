/**
 * Build a Redis connection URL from split `REDIS_*` env vars.
 *
 * Docker Compose and the app share the same vars — `.env` is the single
 * source of truth. `REDIS_TLS=1` produces `rediss://` (TLS) for prod.
 *
 * Returns `null` when `REDIS_HOST` is missing; callers decide whether
 * that is fatal.
 */
interface RedisEnv {
  REDIS_HOST?: string;
  REDIS_PORT?: string;
  REDIS_USER?: string;
  REDIS_PASSWORD?: string;
  REDIS_TLS?: string;
}

export function resolveRedisUrl(env: RedisEnv = process.env as RedisEnv): string | null {
  const host = env.REDIS_HOST;
  if (!host) return null;

  const port = env.REDIS_PORT ?? "6379";
  const scheme = env.REDIS_TLS === "1" || env.REDIS_TLS === "true" ? "rediss" : "redis";
  const auth =
    env.REDIS_USER || env.REDIS_PASSWORD
      ? `${encodeURIComponent(env.REDIS_USER ?? "")}:${encodeURIComponent(env.REDIS_PASSWORD ?? "")}@`
      : "";
  return `${scheme}://${auth}${host}:${port}`;
}
