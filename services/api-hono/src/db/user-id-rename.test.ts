/**
 * Specification for the api_key_id -> user_id rename.
 *
 * The cutover repointed six foreign keys from api_keys.id to
 * users.id but deliberately left the column names alone, so the schema read as
 * a lie: `api_key_id` holding a user id. This migration finishes the job.
 *
 * It is a pure rename, which makes the interesting assertion the one that is
 * easy to skip: renaming must carry the DATA across. A migration that dropped
 * api_key_id and added an empty user_id would satisfy every structural check
 * below and silently destroy every reading position in the library.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { applyMigration, createTestDb, readMigrationDirs, type MigrationFile } from "./test-utils";

const RENAME_SUFFIX = "_user_id_rename";

function splitMigrations(): { before: MigrationFile[]; rename: MigrationFile } {
  const all = readMigrationDirs();
  const index = all.findIndex((m) => m.name.endsWith(RENAME_SUFFIX));
  if (index === -1) {
    throw new Error(`No migration directory ending in "${RENAME_SUFFIX}" was found`);
  }
  return { before: all.slice(0, index), rename: all[index] };
}

interface ColumnInfo {
  data_type: string;
  is_nullable: "YES" | "NO";
}

async function column(pglite: PGlite, table: string, col: string): Promise<ColumnInfo | undefined> {
  const result = await pglite.query<ColumnInfo>(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, col],
  );
  return result.rows[0];
}

interface ForeignKeyInfo {
  ref_table: string;
  ref_column: string;
  delete_rule: string;
}

async function foreignKey(
  pglite: PGlite,
  table: string,
  col: string,
): Promise<ForeignKeyInfo | undefined> {
  const result = await pglite.query<ForeignKeyInfo>(
    `SELECT ccu.table_name  AS ref_table,
            ccu.column_name AS ref_column,
            rc.delete_rule  AS delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
       JOIN information_schema.referential_constraints rc
         ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1
        AND kcu.column_name = $2`,
    [table, col],
  );
  return result.rows[0];
}

async function relationNames(pglite: PGlite, table: string): Promise<string[]> {
  const indexes = await pglite.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  const constraints = await pglite.query<{ name: string }>(
    `SELECT constraint_name AS name
       FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return [...indexes.rows, ...constraints.rows].map((r) => r.name);
}

const RENAMED: { table: string; nullable: boolean; onDelete: string }[] = [
  { table: "reading_progress", nullable: false, onDelete: "CASCADE" },
  { table: "reading_progress_history", nullable: true, onDelete: "SET NULL" },
  { table: "reading_aggregate", nullable: false, onDelete: "CASCADE" },
  { table: "service_credentials", nullable: false, onDelete: "CASCADE" },
  { table: "upload_registry", nullable: false, onDelete: "CASCADE" },
  { table: "hardcover_sync_log", nullable: false, onDelete: "CASCADE" },
];

describe("user_id rename — resulting schema", () => {
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await createTestDb());
  });

  for (const { table, nullable, onDelete } of RENAMED) {
    it(`${table}.user_id replaces api_key_id, keeping its type and delete rule`, async () => {
      const info = await column(pglite, table, "user_id");
      expect(info).toBeDefined();
      expect(info?.data_type).toBe("text");
      expect(info?.is_nullable).toBe(nullable ? "YES" : "NO");

      // The old name must be gone, not merely shadowed: leaving it behind
      // would let a stale query keep writing to a column nothing reads.
      expect(await column(pglite, table, "api_key_id")).toBeUndefined();

      const fk = await foreignKey(pglite, table, "user_id");
      expect(fk).toEqual({ ref_table: "users", ref_column: "id", delete_rule: onDelete });
    });
  }

  it("leaves no index or constraint still named after api keys", async () => {
    // Index and constraint names are the part of a rename that is easiest to
    // forget, and the part a reader trusts most when working out what a column
    // means. `upload_registry_checksum_api_key_uniq` on a user id is exactly
    // the kind of stale signpost that outlives everyone who knew better.
    for (const { table } of RENAMED) {
      const names = await relationNames(pglite, table);
      expect(names.filter((n) => n.includes("api_key"))).toEqual([]);
    }
  });
});

describe("user_id rename — data", () => {
  it("carries existing rows across the rename", async () => {
    const { before, rename } = splitMigrations();
    const pglite = new PGlite({ extensions: { pg_trgm } });
    for (const migration of before) await applyMigration(pglite, migration);

    await pglite.exec(`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
      VALUES ('usr_reader', 'Reader', 'reader@example.test', true, now(), now());
      INSERT INTO reading_progress (api_key_id, document, device, progress, percentage, timestamp)
      VALUES ('usr_reader', 'doc-1', 'kobo', '/body/DocFragment[3]', 0.42, 1);
      INSERT INTO upload_registry (checksum, api_key_id, filename)
      VALUES ('abc123', 'usr_reader', 'book.epub');
    `);

    await applyMigration(pglite, rename);

    const progress = await pglite.query<{ user_id: string; percentage: string }>(
      `SELECT user_id, percentage FROM reading_progress WHERE document = 'doc-1'`,
    );
    expect(progress.rows).toEqual([{ user_id: "usr_reader", percentage: "0.4200" }]);

    const upload = await pglite.query<{ user_id: string }>(
      `SELECT user_id FROM upload_registry WHERE checksum = 'abc123'`,
    );
    expect(upload.rows).toEqual([{ user_id: "usr_reader" }]);

    await pglite.close();
  });
});
