/**
 * Build a Postgres connection URL from split `POSTGRES_*` env vars,
 * or return `DATABASE_URL` verbatim when it is set.
 *
 * `DATABASE_URL` is the escape hatch for prod, CI, and tests — it always
 * wins. In dev, the split vars let `.env` and `docker-compose.dev.yml`
 * share one source of truth: compose interpolates the same `POSTGRES_*`
 * values, and this helper assembles the URL for the app.
 *
 * Returns `null` when neither form is complete; callers decide whether
 * that is fatal (runtime config) or OK (drizzle-kit CLI defaults).
 */
interface DbEnv {
  DATABASE_URL?: string;
  POSTGRES_HOST?: string;
  POSTGRES_PORT?: string;
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  POSTGRES_DB?: string;
}

export function resolveDatabaseUrl(env: DbEnv = process.env as DbEnv): string | null {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = env;
  if (!POSTGRES_HOST || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    return null;
  }

  const port = env.POSTGRES_PORT ?? "5432";
  const user = encodeURIComponent(POSTGRES_USER);
  const password = encodeURIComponent(POSTGRES_PASSWORD);
  return `postgresql://${user}:${password}@${POSTGRES_HOST}:${port}/${POSTGRES_DB}`;
}
