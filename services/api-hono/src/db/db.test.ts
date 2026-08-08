import type { PGlite } from "@electric-sql/pglite";
import { eq, ne } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import * as schema from "./schema";
import { createTestDb, readMigrationDirs, type TestDb } from "./test-utils";

let pglite: PGlite;
let db: TestDb;

/**
 * Since the Better Auth cutover every owned row hangs off a user, and
 * books.created_by is NOT NULL. This one user owns all the fixtures; tests that
 * need a second owner call insertUser().
 *
 * It is created once and never deleted — books RESTRICT on their owner, so
 * tearing users down between tests would just fight the cleanup order.
 */
const OWNER_ID = "usr_fixture_owner";

/** A user to own fixtures. Better Auth generates text ids, so any string works. */
async function insertUser(id: string): Promise<string> {
  await db
    .insert(schema.users)
    .values({ id, name: id, email: `${id}@example.test`, role: "user" })
    .onConflictDoNothing();
  return id;
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  await insertUser(OWNER_ID);
});

afterAll(async () => {
  await pglite.close();
});

afterEach(async () => {
  // Clean all tables between tests (order matters for FK constraints)
  await db.delete(schema.bookMetadataCandidates);
  await db.delete(schema.bookFiles);
  await db.delete(schema.readingProgress);
  await db.delete(schema.readingProgressHistory);
  await db.delete(schema.hardcoverSyncLog);
  await db.delete(schema.apiKeys);
  await db.delete(schema.serviceCredentials);
  await db.delete(schema.books);
  // Books RESTRICT on their owner, so users go last — and OWNER_ID stays.
  await db.delete(schema.users).where(ne(schema.users.id, OWNER_ID));
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("runs all migrations on a fresh database", async () => {
    // `>= 1` was vacuous (libris-59m.31): beforeAll had already run them, so the
    // journal could not have been empty. The journal must hold exactly one row
    // per migration directory on disk, which is what "all of them ran" means.
    const result = await pglite.query<{ cnt: string }>(
      `SELECT count(*) as cnt FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(result.rows[0]!.cnt)).toBe(readMigrationDirs().length);
  });

  // The drift check is deliberately TWO tests (libris-8bb).
  //
  // Asking drizzle-kit the question is slow; comparing its answer against
  // "nothing" is instant, and is the actual assertion. As one test the two
  // shared a failure line, so a run that was merely too slow reported as
  //
  //   migrations > leaves no drift ... Test timed out in 30000ms
  //
  // which sends the reader hunting a schema/migration mismatch that does not
  // exist. That is a worse cost than the flake itself.
  //
  // Split, a slow run can only be reported against the PROBE, under a name that
  // makes no claim about the schema, with an onTestFailed note saying so out
  // loud. The drift assertion below goes red if and only if drizzle-kit really
  // answered with work left to do; if it never answered, that test SKIPS.
  //
  // Note on why the timeout is Vitest's and not a Promise.race deadline of our
  // own: `pushSchema` runs as one uninterrupted synchronous block (PGlite is
  // WASM on this thread, and the diffing is plain CPU work). A setTimeout armed
  // before it cannot fire until it returns — measured: a 1ms timer stayed
  // unfired across the whole call. Only the runner's own timeout, which is
  // enforced from outside the block, can end it. So the budget below is passed
  // to `it()` and nothing races it.

  /**
   * How long drizzle-kit gets to answer.
   *
   * The work is I/O- and CPU-bound on a subprocess-sized workload rather than
   * anything this suite controls, so the right budget is generous rather than
   * tight: Vitest's 30s default was enough on an idle machine and not enough on
   * a loaded one, which is the whole of libris-8bb. Overridable so the timeout
   * path can be exercised on demand (`LIBRIS_DRIFT_PROBE_TIMEOUT_MS=1`).
   */
  const DRIFT_PROBE_TIMEOUT_MS = Number(process.env.LIBRIS_DRIFT_PROBE_TIMEOUT_MS ?? 180_000);

  /**
   * The statements drizzle-kit says are still outstanding, or `null` if it never
   * got to say. `null` is not "no drift" and must never be asserted against.
   */
  let pendingSchemaStatements: string[] | null = null;

  it(
    "asks drizzle-kit what still separates the migrated database from schema.ts",
    async (ctx) => {
      // Fires on any failure of this test, Vitest's own timeout included, which
      // is the case that used to be unreadable. stderr rather than console.warn
      // for the same reason announceSkip() uses it: the reporter cannot attach
      // console output to a test that was killed.
      ctx.onTestFailed(() => {
        process.stderr.write(
          `\n[NOT DRIFT] The drift probe failed before drizzle-kit answered, so NO comparison ` +
            `between the migrations and schema.ts was performed. This failure is not evidence ` +
            `that they disagree, and "leaves no drift ..." below is skipped rather than red for ` +
            `that reason. If the error above is a timeout, the budget is ` +
            `${DRIFT_PROBE_TIMEOUT_MS}ms (LIBRIS_DRIFT_PROBE_TIMEOUT_MS) and a loaded machine is ` +
            `the usual cause -- re-run this file on its own before suspecting the schema.\n\n`,
        );
      });

      const { pushSchema } = await import("drizzle-kit/api-postgres");

      // pushSchema prompts when it hits an ambiguous rename. Pretending not to
      // be a terminal turns that into a thrown error rather than a hung run.
      const wasTTY = process.stdout.isTTY;
      process.stdout.isTTY = false;
      try {
        const { sqlStatements } = await pushSchema(schema, db as never);
        pendingSchemaStatements = sqlStatements;
      } finally {
        process.stdout.isTTY = wasTTY;
      }
    },
    DRIFT_PROBE_TIMEOUT_MS,
  );

  it("leaves no drift between the migrations and schema.ts", (ctx) => {
    // Nothing left to do means the migrations and schema.ts agree.
    //
    // This matters most for hand-written migrations — the Better Auth cutover
    // is one, because its DDL has to interleave with a data backfill that
    // drizzle-kit cannot generate. Without this check, a mismatch between the
    // SQL and the schema would only surface as a confusing runtime error.
    if (pendingSchemaStatements === null) {
      // Skipped rather than failed, on purpose: the probe above is already red,
      // and reporting THIS name red as well is exactly the misdiagnosis
      // libris-8bb exists to remove. The run is still red overall.
      ctx.skip(
        "drizzle-kit never answered -- see the failure on the probe above. A comparison that " +
          "did not run is not a drift finding.",
      );
      return;
    }
    expect(pendingSchemaStatements).toEqual([]);
  });

  it("creates the book_status enum type", async () => {
    const result = await pglite.query(
      `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = 'book_status' ORDER BY enumsortorder`,
    );
    expect(result.rows.map((r: any) => r.enumlabel)).toEqual(["inbox", "review", "organized"]);
  });

  it("creates all expected tables", async () => {
    const result = await pglite.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const tables = result.rows.map((r: any) => r.tablename);
    expect(tables).toContain("books");
    expect(tables).toContain("book_files");
    expect(tables).toContain("book_metadata_candidates");
    expect(tables).toContain("reading_progress");
    expect(tables).toContain("api_keys");
  });

  it("creates indexes", async () => {
    const result = await pglite.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    );
    const indexes = result.rows.map((r: any) => r.indexname);
    expect(indexes).toContain("book_files_book_id_idx");
    expect(indexes).toContain("book_files_checksum_idx");
    expect(indexes).toContain("book_metadata_candidates_book_id_idx");
    expect(indexes).toContain("api_keys_reference_id_idx");
    expect(indexes).toContain("books_status_created_at_idx");
    expect(indexes).toContain("books_isbn13_idx");
    expect(indexes).toContain("reading_progress_book_id_idx");
    expect(indexes).toContain("reading_progress_history_book_id_idx");
    expect(indexes).toContain("reading_progress_history_document_created_at_idx");
    expect(indexes).toContain("hardcover_sync_log_last_synced_at_idx");
    // Redundant indexes removed — these should NOT exist
    expect(indexes).not.toContain("reading_progress_doc_device_idx");
    expect(indexes).not.toContain("hardcover_sync_log_book_id_idx");
    expect(indexes).not.toContain("books_status_idx");
    expect(indexes).not.toContain("reading_progress_history_doc_idx");
    // Replaced by api_keys_key_uniq in the Better Auth cutover.
    expect(indexes).not.toContain("api_keys_key_prefix_idx");
  });

  it("creates unique constraints", async () => {
    const result = await pglite.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'u' ORDER BY conname`,
    );
    const constraints = result.rows.map((r: any) => r.conname);
    expect(constraints).toContain("book_candidates_book_source_uniq");
    expect(constraints).toContain("reading_progress_user_document_device_uniq");
  });

  it("keeps the drizzle-kit snapshot chain single-leafed", async () => {
    // drizzle-kit stores each migration's ancestry in snapshot.json's `prevIds`.
    // A snapshot nobody names as a parent is a "leaf". More than one leaf means
    // the history has branched, and plain `drizzle-kit generate` refuses to run
    // ("Non-commutative migrations detected") until the branch is resolved --
    // which is how libris-59m.45 was found. Passing --ignore-conflicts hides the
    // branch rather than fixing it, so this test is the thing that has to notice.
    const { readFileSync, readdirSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const nodeUrl = await import("node:url");
    const dir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    const migrationsDir = nodePath.resolve(dir, "../../migrations");

    const folders = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const snapshots = folders.map((name) => ({
      name,
      ...(JSON.parse(readFileSync(nodePath.join(migrationsDir, name, "snapshot.json"), "utf8")) as {
        id: string;
        prevIds: string[];
      }),
    }));

    const ids = new Set(snapshots.map((s) => s.id));
    const referencedAsParent = new Set(snapshots.flatMap((s) => s.prevIds));
    const leaves = snapshots.filter((s) => !referencedAsParent.has(s.id)).map((s) => s.name);

    // Exactly one tip, and it is the newest migration by folder name -- which is
    // also the snapshot drizzle-kit diffs against when generating the next one.
    expect(leaves).toEqual([folders[folders.length - 1]]);

    // Only the very first migration may descend from the origin UUID; every
    // other prevId must name a snapshot that actually exists in this folder.
    const ORIGIN = "00000000-0000-0000-0000-000000000000";
    const ancestry = snapshots.map((s, i) => ({
      name: s.name,
      resolves:
        s.prevIds.length === 1 && (i === 0 ? s.prevIds[0] === ORIGIN : ids.has(s.prevIds[0])),
    }));
    expect(ancestry.filter((a) => !a.resolves)).toEqual([]);
  });

  it("re-running migrations is idempotent", async () => {
    // Should not throw on a second migration run
    const fresh = await createTestDb();
    // Second run should be a no-op (journal entries already recorded)
    const nodePath = await import("node:path");
    const nodeUrl = await import("node:url");
    const dir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    await migrate(fresh.db, { migrationsFolder: nodePath.resolve(dir, "../../migrations") });

    // `>= 1` made this a test that migrate() did not throw (libris-59m.31).
    // Idempotent means the journal did not GROW: a second run that re-applied
    // everything would double the row count, which is exactly the failure the
    // branched-snapshot bug produced on deploy.
    const result = await fresh.pglite.query<{ cnt: string }>(
      `SELECT count(*) as cnt FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(result.rows[0]!.cnt)).toBe(readMigrationDirs().length);
    await fresh.pglite.close();
  });
});

// ---------------------------------------------------------------------------
// Schema/DDL tests (using PGlite)
// ---------------------------------------------------------------------------

/**
 * SCHEMA-level tests (libris-59m.31).
 *
 * The five blocks below drive Drizzle and PostgreSQL directly — no `src/` route,
 * service or worker runs in any of them, so no application change can turn one
 * red. That is legitimate for what they DO pin: the DDL the migrations produce
 * (constraints, defaults, foreign keys, cascades). It is not coverage of
 * anything above the database, and they were named "books CRUD" / "apiKeys
 * CRUD" as if it were. Renamed so a close-reason cannot cite them for behaviour
 * they never exercised.
 *
 * The one test in this file that guards the schema against real drift is
 * "leaves no drift between the migrations and schema.ts" above.
 */

describe("SCHEMA: books table", () => {
  it("inserts a book with defaults", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();

    expect(book.id).toBeDefined();
    expect(book.status).toBe("inbox");
    expect(book.genres).toEqual([]);
    expect(book.tags).toEqual([]);
    expect(book.createdAt).toBeInstanceOf(Date);
    expect(book.updatedAt).toBeInstanceOf(Date);
  });

  it("inserts a book with all fields", async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "The Great Gatsby",
        author: "F. Scott Fitzgerald",
        isbn13: "9780743273565",
        publisher: "Scribner",
        publishedYear: 1925,
        language: "en",
        description: "A novel",
        pageCount: 180,
        genres: ["fiction"],
        tags: ["classic"],
        status: "review",
      })
      .returning();

    expect(book.title).toBe("The Great Gatsby");
    expect(book.author).toBe("F. Scott Fitzgerald");
    expect(book.status).toBe("review");
    expect(book.genres).toEqual(["fiction"]);
    expect(book.publishedYear).toBe(1925);
  });

  it("updates a book", async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "Old",
      })
      .returning();
    const [updated] = await db
      .update(schema.books)
      .set({ title: "New", status: "organized" })
      .where(eq(schema.books.id, book.id))
      .returning();

    expect(updated.title).toBe("New");
    expect(updated.status).toBe("organized");
  });

  it("deletes a book", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const result = await db.query.books.findFirst({
      where: { id: book.id },
    });
    expect(result).toBeUndefined();
  });

  it("queries with relational API", async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "Rel Test",
      })
      .returning();
    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "test.epub",
    });

    const result = await db.query.books.findFirst({
      where: { id: book.id },
    });
    expect(result).toBeDefined();
    expect(result!.title).toBe("Rel Test");
  });

  it("loads book files via relation", async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "With Files",
      })
      .returning();
    await db.insert(schema.bookFiles).values([
      { bookId: book.id, format: "epub", originalName: "file.epub" },
      { bookId: book.id, format: "pdf", originalName: "file.pdf" },
    ]);

    const result = await db.query.books.findFirst({
      where: { id: book.id },
      with: { files: true },
    });
    expect(result!.files).toHaveLength(2);
    expect(result!.files.map((f) => f.format).sort()).toEqual(["epub", "pdf"]);
  });

  it("loads metadata candidates via relation", async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "With Candidates",
      })
      .returning();
    await db.insert(schema.bookMetadataCandidates).values([
      { bookId: book.id, source: "openlibrary" },
      { bookId: book.id, source: "google" },
    ]);

    const result = await db.query.books.findFirst({
      where: { id: book.id },
      with: { metadataCandidates: true },
    });
    expect(result!.metadataCandidates).toHaveLength(2);
    expect(result!.metadataCandidates.map((c) => c.source).sort()).toEqual([
      "google",
      "openlibrary",
    ]);
  });
});

describe("SCHEMA: book_files table", () => {
  it("inserts a file linked to a book", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    const [file] = await db
      .insert(schema.bookFiles)
      .values({
        bookId: book.id,
        format: "pdf",
        originalName: "document.pdf",
        storagePath: "/library/doc.pdf",
        fileSize: 1024,
        checksum: "abc123",
      })
      .returning();

    expect(file.bookId).toBe(book.id);
    expect(file.format).toBe("pdf");
    expect(file.fileSize).toBe(1024);
  });

  it("cascades delete when parent book is deleted", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    await db.insert(schema.bookFiles).values({
      bookId: book.id,
      format: "epub",
      originalName: "test.epub",
    });

    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const files = await db
      .select()
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.bookId, book.id));
    expect(files).toHaveLength(0);
  });

  it("rejects insert with non-existent bookId", async () => {
    await expect(
      db.insert(schema.bookFiles).values({
        bookId: "00000000-0000-0000-0000-000000000000",
        format: "epub",
        originalName: "orphan.epub",
      }),
    ).rejects.toThrow();
  });
});

describe("SCHEMA: book_candidates table", () => {
  it("inserts metadata candidate with jsonb", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    const [candidate] = await db
      .insert(schema.bookMetadataCandidates)
      .values({
        bookId: book.id,
        source: "openlibrary",
        rawResponse: { title: "Test", authors: ["Author"] },
        normalized: { title: "Test" },
        confidence: "0.9500",
      })
      .returning();

    expect(candidate.source).toBe("openlibrary");
    expect(candidate.rawResponse).toEqual({ title: "Test", authors: ["Author"] });
    expect(candidate.confidence).toBe("0.9500");
  });

  it("enforces unique constraint on (bookId, source)", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book.id,
      source: "openlibrary",
    });

    await expect(
      db.insert(schema.bookMetadataCandidates).values({
        bookId: book.id,
        source: "openlibrary",
      }),
    ).rejects.toThrow();
  });

  it("allows same source for different books", async () => {
    const [book1] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    const [book2] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();

    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book1.id,
      source: "openlibrary",
    });
    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book2.id,
      source: "openlibrary",
    });

    const all = await db.select().from(schema.bookMetadataCandidates);
    expect(all).toHaveLength(2);
  });

  it("cascades delete when parent book is deleted", async () => {
    const [book] = await db.insert(schema.books).values({ createdBy: OWNER_ID }).returning();
    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book.id,
      source: "google",
    });

    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const candidates = await db
      .select()
      .from(schema.bookMetadataCandidates)
      .where(eq(schema.bookMetadataCandidates.bookId, book.id));
    expect(candidates).toHaveLength(0);
  });
});

describe("SCHEMA: reading_progress table", () => {
  it("inserts reading progress", async () => {
    const owner = await insertUser("usr_insert_progress_test_hash");

    const [progress] = await db
      .insert(schema.readingProgress)
      .values({
        document: "book.epub",
        device: "Kindle Paperwhite",
        deviceId: "K001",
        progress: "42%",
        percentage: "0.4200",
        timestamp: 1234567890n,
        rawPayload: { page: 42 },
        userId: owner,
      })
      .returning();

    expect(progress.document).toBe("book.epub");
    expect(progress.percentage).toBe("0.4200");
    expect(progress.timestamp).toBe(1234567890n);
  });

  it("enforces unique constraint on (userId, document, device)", async () => {
    const owner = await insertUser("usr_unique_constraint_test_hash");

    await db.insert(schema.readingProgress).values({
      document: "book.epub",
      device: "Kindle",
      progress: "10%",
      userId: owner,
    });

    await expect(
      db.insert(schema.readingProgress).values({
        document: "book.epub",
        device: "Kindle",
        progress: "20%",
        userId: owner,
      }),
    ).rejects.toThrow();
  });

  it("allows same document on different devices", async () => {
    const owner = await insertUser("usr_diff_devices_test_hash");

    await db.insert(schema.readingProgress).values({
      document: "shared.epub",
      device: "Kindle",
      progress: "10%",
      userId: owner,
    });
    await db.insert(schema.readingProgress).values({
      document: "shared.epub",
      device: "iPad",
      progress: "20%",
      userId: owner,
    });

    const all = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.document, "shared.epub"));
    expect(all).toHaveLength(2);
  });

  it("stores nullable book_id on reading progress", async () => {
    const owner = await insertUser("usr_nullable_book_test_hash");

    const [progress] = await db
      .insert(schema.readingProgress)
      .values({ document: "hash.epub", device: "KoReader", progress: "5%", userId: owner })
      .returning();
    expect(progress.bookId).toBeNull();
  });

  it("links reading progress to a book via book_id", async () => {
    const owner = await insertUser("usr_linked_book_test_hash");

    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "Linked Book",
      })
      .returning();
    const [progress] = await db
      .insert(schema.readingProgress)
      .values({
        bookId: book.id,
        document: "linked.epub",
        device: "KoReader",
        progress: "20%",
        userId: owner,
      })
      .returning();
    expect(progress.bookId).toBe(book.id);
  });

  it("sets book_id to null when book is deleted", async () => {
    const owner = await insertUser("usr_book_delete_null_test_hash");

    const [book] = await db
      .insert(schema.books)
      .values({
        createdBy: OWNER_ID,
        title: "To Delete",
      })
      .returning();
    await db.insert(schema.readingProgress).values({
      bookId: book.id,
      document: "orphan.epub",
      device: "KoReader",
      progress: "50%",
      userId: owner,
    });

    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const [progress] = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.document, "orphan.epub"));
    expect(progress!.bookId).toBeNull();
  });
});

// App passwords. Since the Better Auth cutover an api key is a credential
// belonging to a user, not an identity of its own — the plugin owns this table,
// so these tests cover the shape and constraints rather than any Libris logic.
describe("SCHEMA: api_keys table", () => {
  it("inserts an app password with the plugin's defaults", async () => {
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        id: "key_insert",
        referenceId: OWNER_ID,
        key: "hashed_secret_1",
        name: "Kobo Clara",
        start: "libris_ab",
      })
      .returning();

    expect(key.referenceId).toBe(OWNER_ID);
    expect(key.name).toBe("Kobo Clara");
    expect(key.configId).toBe("default");
    expect(key.enabled).toBe(true);
    expect(key.rateLimitEnabled).toBe(true);
    expect(key.rateLimitMax).toBe(10);
    expect(key.rateLimitTimeWindow).toBe(86_400_000);
    expect(key.requestCount).toBe(0);
    expect(key.createdAt).toBeInstanceOf(Date);
    expect(key.expiresAt).toBeNull();
  });

  it("rejects a duplicate key hash", async () => {
    await db.insert(schema.apiKeys).values({
      id: "key_dup_a",
      referenceId: OWNER_ID,
      key: "duplicate_hash",
    });

    await expect(
      db.insert(schema.apiKeys).values({
        id: "key_dup_b",
        referenceId: OWNER_ID,
        key: "duplicate_hash",
      }),
    ).rejects.toThrow();
  });

  it("rejects a key that belongs to nobody", async () => {
    await expect(
      db.insert(schema.apiKeys).values({
        id: "key_orphan",
        referenceId: "usr_does_not_exist",
        key: "orphan_hash",
      }),
    ).rejects.toThrow();
  });

  it("records usage on lastRequest", async () => {
    const [key] = await db
      .insert(schema.apiKeys)
      .values({ id: "key_used", referenceId: OWNER_ID, key: "hash_for_update" })
      .returning();
    expect(key.lastRequest).toBeNull();

    const now = new Date();
    const [updated] = await db
      .update(schema.apiKeys)
      .set({ lastRequest: now, requestCount: 1 })
      .where(eq(schema.apiKeys.id, key.id))
      .returning();

    expect(updated.lastRequest).toEqual(now);
    expect(updated.requestCount).toBe(1);
  });

  it("revoking a user's app password leaves their reading history alone", async () => {
    // The reason the epic exists: api_keys used to BE the user table, so
    // deleting a key cascaded into reading_progress.
    const owner = await insertUser("usr_revoke");
    await db.insert(schema.apiKeys).values({
      id: "key_revoke",
      referenceId: owner,
      key: "revoke_hash",
    });
    await db.insert(schema.readingProgress).values({
      document: "kept.epub",
      device: "KoReader",
      progress: "30%",
      userId: owner,
    });

    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, "key_revoke"));

    const kept = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.document, "kept.epub"));
    expect(kept).toHaveLength(1);
  });
});
