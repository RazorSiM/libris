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
import type { Env } from "../env";
import { createAuth, type Auth } from "../lib/auth";
import { createMemorySecondaryStorage } from "../services/auth-secondary-storage";
import { relations } from "./relations";
import * as schema from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../migrations");

export type TestDb = ReturnType<typeof drizzle<typeof schema, typeof relations>>;

export interface MigrationFile {
  name: string;
  sql: string;
  hash: string;
  folderMillis: number;
}

/** Read v1-format migration subdirectories sorted by timestamp prefix. */
export function readMigrationDirs(): MigrationFile[] {
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
 * Apply one migration file, splitting it the same way Drizzle's migrator does.
 *
 * Exported so migration-level tests can stop before a given migration, seed the
 * pre-migration data shape, and then apply just that one — which is the only way
 * to exercise a data backfill (see auth-cutover.test.ts).
 */
export async function applyMigration(pglite: PGlite, migration: MigrationFile): Promise<void> {
  const statements = migration.sql.split("--> statement-breakpoint").map((s) => s.trim());
  for (const stmt of statements) {
    if (stmt) await pglite.exec(stmt);
  }
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
    await applyMigration(pglite, migration);
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

let seedUserSeq = 0;

/**
 * Insert a user directly and return its id.
 *
 * Ownership moved from the api key to the person in libris-5ng.7, so the many
 * suites that used to mint an api key purely to have an owner id now need a
 * user instead. This writes the row directly rather than going through
 * `auth.api.createUser` because most of those suites only need an id to hang
 * books and reading progress off — they never sign in, and paying for a
 * password hash per fixture would slow the suite down for nothing. Tests that
 * do authenticate should use `createTestAuth` and go through Better Auth.
 */
export async function seedUser(
  db: TestDb,
  options: { name?: string; email?: string; role?: "user" | "admin" } = {},
): Promise<string> {
  seedUserSeq += 1;
  const id = `usr_seed_${seedUserSeq}`;
  await db.insert(schema.users).values({
    id,
    name: options.name ?? `Seed User ${seedUserSeq}`,
    email: options.email ?? `${id}@example.test`,
    emailVerified: true,
    role: options.role ?? "user",
  });
  return id;
}

/**
 * A user plus a real Better Auth app password they can authenticate with.
 *
 * Replaces the `seedApiKey()` helper the route suites each had a copy of, which
 * hand-wrote a row into the old api_keys table. That table is Better Auth's
 * now, and its `key` column holds a hash the plugin computes — so a fixture
 * cannot construct a working credential by inserting a row. It has to go
 * through createApiKey, which accepts a server-side userId with no session.
 *
 * The returned key works as `Authorization: Bearer`, as Basic's password, and
 * as `x-api-key` (see apiKeyFromHeaders in lib/auth.ts).
 */
export async function seedAppPassword(
  auth: Auth,
  db: TestDb,
  options: { name?: string; role?: "user" | "admin" } = {},
): Promise<{ userId: string; rawKey: string }> {
  const userId = await seedUser(db, { name: options.name, role: options.role });
  const created = await auth.api.createApiKey({
    body: { userId, name: options.name ?? "Test Key" },
  });
  return { userId, rawKey: created.key };
}

/**
 * Better Auth instance for tests, backed by in-memory secondary storage.
 *
 * Exists so the ~8 route suites that build an AppServices object do not each
 * have to wire up createAuth: `auth` is required at runtime, so it cannot be
 * omitted, and duplicating its construction would mean touching every suite
 * again on the next signature change.
 */
export function createTestAuth(db: TestDb, env: Env): Auth {
  return createAuth({
    db: db as unknown as Parameters<typeof createAuth>[0]["db"],
    secondaryStorage: createMemorySecondaryStorage(),
    env,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: "http://localhost:3000",
  });
}
