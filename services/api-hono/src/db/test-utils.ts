/**
 * Shared PGlite test helper -- creates an in-memory database with pg_trgm
 * and runs all migrations.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { relations } from "./relations";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema, typeof relations>>;

/** Read v1-format migration subdirectories sorted by timestamp prefix. */
function readMigrationDirs(): { name: string; sql: string; hash: string; folderMillis: number }[] {
  return readdirSync(migrationsFolder)
    .filter((subdir) => existsSync(join(migrationsFolder, subdir, "migration.sql")))
    .sort()
    .map((subdir) => {
      const sqlContent = readFileSync(join(migrationsFolder, subdir, "migration.sql"), "utf-8");
      // Directory name is "{epochMillis}_{name}" — extract the timestamp prefix
      const folderMillis = parseInt(subdir.split("_")[0], 10);
      const hash = createHash("sha256").update(sqlContent).digest("hex");
      return { name: subdir, sql: sqlContent, hash, folderMillis };
    });
}

/**
 * Creates a PGlite instance with pg_trgm and runs all migrations.
 * Returns { pglite, db } for use in tests.
 */
export async function createTestDb(): Promise<{ pglite: PGlite; db: TestDb }> {
  const pglite = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle({ client: pglite, schema, relations });

  const migrations = readMigrationDirs();

  for (const migration of migrations) {
    const statements = migration.sql.split("--> statement-breakpoint").map((s) => s.trim());
    for (const stmt of statements) {
      if (stmt) await pglite.exec(stmt);
    }
  }

  // Mark migrations as applied in Drizzle's v1 journal table so re-running
  // migrate() is a no-op (idempotent test in db.test.ts needs this).
  await pglite.exec(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      name text,
      applied_at timestamp with time zone DEFAULT now()
    );
  `);

  // Insert a journal entry per migration so Drizzle considers them applied
  for (const migration of migrations) {
    await pglite.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)`,
      [migration.hash, migration.folderMillis, migration.name],
    );
  }

  return { pglite, db };
}
