/**
 * Specification for the Better Auth cutover migration (libris-5ng.7).
 *
 * Two halves, and they need different setups:
 *
 * - The STRUCTURE tests run against a fully migrated database and assert the
 *   end state: column types, nullability, and every foreign key's delete rule.
 * - The BACKFILL tests stop one migration short, seed the *legacy* shape by raw
 *   SQL (the Drizzle schema describes the post-migration shape, so it cannot be
 *   used to write pre-migration rows), then apply the cutover alone.
 *
 * The cutover is located by directory suffix rather than by index so that
 * later migrations can be added without editing this file.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { applyMigration, createTestDb, readMigrationDirs, type MigrationFile } from "./test-utils";

const CUTOVER_SUFFIX = "_auth_cutover";

function splitMigrations(): { before: MigrationFile[]; cutover: MigrationFile } {
  const all = readMigrationDirs();
  const index = all.findIndex((m) => m.name.endsWith(CUTOVER_SUFFIX));
  if (index === -1) {
    throw new Error(`No migration directory ending in "${CUTOVER_SUFFIX}" was found`);
  }
  return { before: all.slice(0, index), cutover: all[index] };
}

// ---------------------------------------------------------------------------
// information_schema helpers
// ---------------------------------------------------------------------------

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

/** The single foreign key constraint on `table`.`col`, or undefined if there is none. */
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

async function indexNames(pglite: PGlite, table: string): Promise<string[]> {
  const result = await pglite.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return result.rows.map((r) => r.indexname);
}

async function count(pglite: PGlite, sql: string): Promise<number> {
  const result = await pglite.query<{ n: string }>(sql);
  return Number(result.rows[0].n);
}

// ---------------------------------------------------------------------------
// Structure: the shape the cutover leaves behind
// ---------------------------------------------------------------------------

describe("auth cutover — resulting schema", () => {
  let pglite: PGlite;

  beforeAll(async () => {
    ({ pglite } = await createTestDb());
  });

  // Every column that used to point at api_keys.id now points at users.id and
  // carries Better Auth's text ids.
  //
  // These run against a FULLY migrated database, so the column names are the
  // post-rename ones (libris-5ng.10 renamed api_key_id to user_id in a later
  // migration). What this suite still owns is the delete rules: the cutover is
  // where "revoking a credential must not delete a reading history" became
  // true, and user-id-rename.test.ts only asserts the rename preserved them.
  const repointed: { table: string; column: string; nullable: boolean; onDelete: string }[] = [
    { table: "reading_progress", column: "user_id", nullable: false, onDelete: "CASCADE" },
    {
      table: "reading_progress_history",
      column: "user_id",
      nullable: true,
      onDelete: "SET NULL",
    },
    { table: "reading_aggregate", column: "user_id", nullable: false, onDelete: "CASCADE" },
    { table: "service_credentials", column: "user_id", nullable: false, onDelete: "CASCADE" },
    { table: "upload_registry", column: "user_id", nullable: false, onDelete: "CASCADE" },
    { table: "hardcover_sync_log", column: "user_id", nullable: false, onDelete: "CASCADE" },
  ];

  for (const { table, column: col, nullable, onDelete } of repointed) {
    it(`${table}.${col} is text and references users.id ON DELETE ${onDelete}`, async () => {
      const info = await column(pglite, table, col);
      expect(info).toBeDefined();
      expect(info?.data_type).toBe("text");
      expect(info?.is_nullable).toBe(nullable ? "YES" : "NO");

      const fk = await foreignKey(pglite, table, col);
      expect(fk).toEqual({ ref_table: "users", ref_column: "id", delete_rule: onDelete });
    });
  }

  it("books.created_by is text NOT NULL and references users.id ON DELETE RESTRICT", async () => {
    // NOT NULL is what lets libris-5ng.9 delete the "unowned book" authorization
    // branch. RESTRICT is the database backstop: the admin delete-user path
    // reassigns a user's books before removing them, and a path that forgets
    // fails loudly rather than orphaning rows.
    const info = await column(pglite, "books", "created_by");
    expect(info?.data_type).toBe("text");
    expect(info?.is_nullable).toBe("NO");

    expect(await foreignKey(pglite, "books", "created_by")).toEqual({
      ref_table: "users",
      ref_column: "id",
      delete_rule: "RESTRICT",
    });
  });

  it("api_keys is reshaped into the Better Auth apikey model", async () => {
    // Field list taken from getAuthTables() via tmp/spike-5ng/dump-tables.ts,
    // not from the docs. Ownership is the polymorphic reference_id, NOT user_id.
    const expected: Record<string, { type: string; nullable: boolean }> = {
      id: { type: "text", nullable: false },
      config_id: { type: "text", nullable: false },
      name: { type: "text", nullable: true },
      start: { type: "text", nullable: true },
      reference_id: { type: "text", nullable: false },
      prefix: { type: "text", nullable: true },
      key: { type: "text", nullable: false },
      refill_interval: { type: "integer", nullable: true },
      refill_amount: { type: "integer", nullable: true },
      last_refill_at: { type: "timestamp with time zone", nullable: true },
      enabled: { type: "boolean", nullable: true },
      rate_limit_enabled: { type: "boolean", nullable: true },
      rate_limit_time_window: { type: "integer", nullable: true },
      rate_limit_max: { type: "integer", nullable: true },
      request_count: { type: "integer", nullable: true },
      remaining: { type: "integer", nullable: true },
      last_request: { type: "timestamp with time zone", nullable: true },
      expires_at: { type: "timestamp with time zone", nullable: true },
      created_at: { type: "timestamp with time zone", nullable: false },
      updated_at: { type: "timestamp with time zone", nullable: false },
      permissions: { type: "text", nullable: true },
      metadata: { type: "text", nullable: true },
    };

    for (const [col, want] of Object.entries(expected)) {
      const info = await column(pglite, "api_keys", col);
      expect(info, `api_keys.${col} is missing`).toBeDefined();
      expect(info?.data_type, `api_keys.${col} type`).toBe(want.type);
      expect(info?.is_nullable, `api_keys.${col} nullability`).toBe(want.nullable ? "YES" : "NO");
    }

    const result = await pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_keys'`,
    );
    const actual = result.rows.map((r) => r.column_name).sort();
    expect(actual).toEqual(Object.keys(expected).sort());
  });

  it("drops the bespoke api_keys columns and their index", async () => {
    for (const col of ["key_hash", "key_prefix", "is_admin", "label", "last_used_at"]) {
      expect(
        await column(pglite, "api_keys", col),
        `api_keys.${col} should be gone`,
      ).toBeUndefined();
    }
    expect(await indexNames(pglite, "api_keys")).not.toContain("api_keys_key_prefix_idx");
  });

  it("api_keys.reference_id cascades from users so deleting a user revokes their app passwords", async () => {
    expect(await foreignKey(pglite, "api_keys", "reference_id")).toEqual({
      ref_table: "users",
      ref_column: "id",
      delete_rule: "CASCADE",
    });
  });

  it("indexes api_keys.key uniquely and api_keys.reference_id for listing", async () => {
    const names = await indexNames(pglite, "api_keys");
    expect(names).toContain("api_keys_key_uniq");
    expect(names).toContain("api_keys_reference_id_idx");
    expect(names).toContain("api_keys_config_id_idx");
  });
});

// ---------------------------------------------------------------------------
// Backfill: what the cutover does to existing rows
// ---------------------------------------------------------------------------

describe("auth cutover — data backfill", () => {
  let pglite: PGlite;
  let cutover: MigrationFile;

  const ADMIN_KEY = "11111111-1111-4111-8111-111111111111";
  const USER_KEY = "22222222-2222-4222-8222-222222222222";
  const OWNED_BOOK = "33333333-3333-4333-8333-333333333333";
  const ORPHAN_BOOK = "44444444-4444-4444-8444-444444444444";

  /** Migrate to just before the cutover and seed the legacy shape. */
  async function seedLegacy(): Promise<void> {
    const { before, cutover: c } = splitMigrations();
    cutover = c;
    pglite = new PGlite({ extensions: { pg_trgm } });
    for (const migration of before) await applyMigration(pglite, migration);

    await pglite.exec(`
      INSERT INTO api_keys (id, key_prefix, key_hash, label, is_admin) VALUES
        ('${ADMIN_KEY}', 'aaaaaaaa', '$2b$12$adminhash', 'Raz laptop', true),
        ('${USER_KEY}',  'bbbbbbbb', '$2b$12$userhash',  'Housemate',  false);

      INSERT INTO books (id, status, title, created_by) VALUES
        ('${OWNED_BOOK}',  'organized', 'Owned book',  '${USER_KEY}'),
        ('${ORPHAN_BOOK}', 'organized', 'Orphan book', NULL);

      INSERT INTO reading_progress (api_key_id, document, device, progress)
        VALUES ('${USER_KEY}', 'doc-1', 'kobo', '0.5');
      INSERT INTO reading_progress_history (api_key_id, document, device, progress)
        VALUES ('${USER_KEY}', 'doc-1', 'kobo', '0.5');
      INSERT INTO reading_aggregate (api_key_id, book_id)
        VALUES ('${USER_KEY}', '${OWNED_BOOK}');
      INSERT INTO service_credentials (service, api_key_id, username, password_hash)
        VALUES ('opds', '${USER_KEY}', 'housemate', '$2b$12$x');
      INSERT INTO upload_registry (checksum, api_key_id, filename)
        VALUES ('deadbeef', '${USER_KEY}', 'book.epub');
      INSERT INTO hardcover_sync_log (book_id, api_key_id, last_synced_at)
        VALUES ('${OWNED_BOOK}', '${USER_KEY}', now());
    `);
  }

  beforeAll(seedLegacy);

  afterEach(async () => {
    // Each test applies the cutover itself, so state must not leak between them.
    await pglite.close();
    await seedLegacy();
  });

  it("creates exactly one user per api_keys row, preserving the key id as the user id", async () => {
    await applyMigration(pglite, cutover);

    const users = await pglite.query<{ id: string; name: string; email: string; role: string }>(
      `SELECT id, name, email, role FROM users ORDER BY name`,
    );
    expect(users.rows).toHaveLength(2);

    // Reusing the api_keys uuid as the user's text id is what makes step 4
    // (repointing seven columns) a plain cast rather than a join, and makes the
    // whole migration re-runnable.
    expect(users.rows).toEqual([
      { id: USER_KEY, name: "Housemate", email: `${USER_KEY}@migrated.invalid`, role: "user" },
      { id: ADMIN_KEY, name: "Raz laptop", email: `${ADMIN_KEY}@migrated.invalid`, role: "admin" },
    ]);
  });

  it("maps is_admin onto the admin plugin role", async () => {
    await applyMigration(pglite, cutover);
    expect(await count(pglite, `SELECT count(*) n FROM users WHERE role = 'admin'`)).toBe(1);
    expect(await count(pglite, `SELECT count(*) n FROM users WHERE role = 'user'`)).toBe(1);
  });

  it("leaves migrated users with no credential account, so they cannot sign in until reset", async () => {
    // bcrypt key hashes are not password hashes and cannot become one. Every
    // migrated user gets a password from the admin at cutover time.
    await applyMigration(pglite, cutover);
    expect(await count(pglite, `SELECT count(*) n FROM accounts`)).toBe(0);
  });

  it("repoints every dependent row onto the new user without losing any", async () => {
    await applyMigration(pglite, cutover);

    for (const table of [
      "reading_progress",
      "reading_progress_history",
      "reading_aggregate",
      "service_credentials",
      "upload_registry",
      "hardcover_sync_log",
    ]) {
      expect(await count(pglite, `SELECT count(*) n FROM ${table}`), `${table} row count`).toBe(1);
      expect(
        await count(pglite, `SELECT count(*) n FROM ${table} WHERE api_key_id = '${USER_KEY}'`),
        `${table} owner`,
      ).toBe(1);
    }
  });

  it("assigns orphaned books to an admin and makes created_by NOT NULL", async () => {
    await applyMigration(pglite, cutover);

    const books = await pglite.query<{ id: string; created_by: string }>(
      `SELECT id, created_by FROM books ORDER BY title`,
    );
    expect(books.rows).toEqual([
      { id: ORPHAN_BOOK, created_by: ADMIN_KEY },
      { id: OWNED_BOOK, created_by: USER_KEY },
    ]);

    await expect(
      pglite.exec(`INSERT INTO books (status, title) VALUES ('inbox', 'No owner')`),
    ).rejects.toThrow();
  });

  it("clears the legacy bcrypt keys, since they cannot become Better Auth hashes", async () => {
    await applyMigration(pglite, cutover);
    expect(await count(pglite, `SELECT count(*) n FROM api_keys`)).toBe(0);
  });

  it("leaves no orphaned foreign keys", async () => {
    await applyMigration(pglite, cutover);

    for (const table of [
      "reading_progress",
      "reading_progress_history",
      "reading_aggregate",
      "service_credentials",
      "upload_registry",
      "hardcover_sync_log",
    ]) {
      const orphans = await count(
        pglite,
        `SELECT count(*) n FROM ${table} t
          WHERE t.api_key_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.api_key_id)`,
      );
      expect(orphans, `${table} orphans`).toBe(0);
    }

    const bookOrphans = await count(
      pglite,
      `SELECT count(*) n FROM books b
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.created_by)`,
    );
    expect(bookOrphans).toBe(0);
  });

  it("is a no-op when re-run, and does not touch keys issued after the cutover", async () => {
    await applyMigration(pglite, cutover);

    // A post-cutover app password. Re-running must not delete it, which is the
    // real hazard: the legacy transform ends in DELETE FROM api_keys.
    await pglite.exec(`
      INSERT INTO api_keys (id, config_id, reference_id, key, created_at, updated_at)
      VALUES ('key_after', 'default', '${USER_KEY}', 'hashed-secret', now(), now());
    `);

    await applyMigration(pglite, cutover);

    expect(await count(pglite, `SELECT count(*) n FROM users`)).toBe(2);
    expect(await count(pglite, `SELECT count(*) n FROM api_keys`)).toBe(1);
    expect(await count(pglite, `SELECT count(*) n FROM reading_progress`)).toBe(1);
    expect(await count(pglite, `SELECT count(*) n FROM books WHERE created_by IS NOT NULL`)).toBe(
      2,
    );
  });

  it("cascades reading history from the user, not from a revoked credential", async () => {
    await applyMigration(pglite, cutover);

    // Revoking an app password must leave reading history intact — the whole
    // point of decoupling identity from credential.
    await pglite.exec(`
      INSERT INTO api_keys (id, config_id, reference_id, key, created_at, updated_at)
      VALUES ('key_revoke', 'default', '${USER_KEY}', 'hashed-secret', now(), now());
      DELETE FROM api_keys WHERE id = 'key_revoke';
    `);
    expect(await count(pglite, `SELECT count(*) n FROM reading_progress`)).toBe(1);
    expect(await count(pglite, `SELECT count(*) n FROM reading_aggregate`)).toBe(1);

    // Deleting the user does take it.
    await pglite.exec(`DELETE FROM books WHERE created_by = '${USER_KEY}'`);
    await pglite.exec(`DELETE FROM users WHERE id = '${USER_KEY}'`);
    expect(await count(pglite, `SELECT count(*) n FROM reading_progress`)).toBe(0);
    expect(await count(pglite, `SELECT count(*) n FROM reading_aggregate`)).toBe(0);
  });
});
