import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run Drizzle migrations against the given database.
 *
 * @param connectionString - Postgres connection URL
 * @param migrationsFolder - Path to the migrations directory.
 *   Defaults to `../../migrations` relative to this file (works from
 *   `server/db/` inside the API service).
 */
export async function runMigrations(connectionString: string, migrationsFolder?: string) {
  const folder = migrationsFolder ?? resolve(__dirname, "../../migrations");

  const db = drizzle(connectionString);

  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await db.$client.end();
  }
}
