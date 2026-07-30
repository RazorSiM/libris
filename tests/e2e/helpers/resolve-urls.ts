/**
 * Build Postgres / Redis URLs from split env vars — mirrors the resolvers
 * in `services/api-hono/src/lib/resolve-{database,redis}-url.ts`. Duplicated
 * here because the e2e package does not depend on `@libris/api-hono`.
 */

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = env;
  if (!POSTGRES_HOST || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) return null;
  const port = env.POSTGRES_PORT ?? "5432";
  return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${POSTGRES_HOST}:${port}/${POSTGRES_DB}`;
}

export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string | null {
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

export function requireDatabaseUrl(): string {
  const url = resolveDatabaseUrl();
  if (!url) {
    throw new Error(
      "Postgres config missing: set POSTGRES_{HOST,USER,PASSWORD,DB} (POSTGRES_PORT defaults to 5432).",
    );
  }
  return url;
}

export function requireRedisUrl(): string {
  const url = resolveRedisUrl();
  if (!url) {
    throw new Error(
      "Redis config missing: set REDIS_HOST (REDIS_PORT defaults to 6379; set REDIS_TLS=1 for rediss://).",
    );
  }
  return url;
}
