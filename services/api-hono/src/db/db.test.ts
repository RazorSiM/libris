import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import * as schema from "./schema";
import { createTestDb, type TestDb } from "./test-utils";

let pglite: PGlite;
let db: TestDb;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
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
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("runs all migrations on a fresh database", async () => {
    // The beforeAll already ran migrations. Verify the migration journal table exists.
    const result = await pglite.query(`SELECT count(*) as cnt FROM drizzle.__drizzle_migrations`);
    expect(Number((result.rows[0] as Record<string, unknown>).cnt)).toBeGreaterThanOrEqual(1);
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
    expect(indexes).toContain("api_keys_key_prefix_idx");
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
  });

  it("creates unique constraints", async () => {
    const result = await pglite.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'u' ORDER BY conname`,
    );
    const constraints = result.rows.map((r: any) => r.conname);
    expect(constraints).toContain("api_keys_key_hash_key");
    expect(constraints).toContain("book_candidates_book_source_uniq");
    expect(constraints).toContain("reading_progress_user_document_device_uniq");
  });

  it("re-running migrations is idempotent", async () => {
    // Should not throw on a second migration run
    const fresh = await createTestDb();
    // Second run should be a no-op (journal entries already recorded)
    const nodePath = await import("node:path");
    const nodeUrl = await import("node:url");
    const dir = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
    await migrate(fresh.db, { migrationsFolder: nodePath.resolve(dir, "../../migrations") });

    const result = await fresh.pglite.query(
      `SELECT count(*) as cnt FROM drizzle.__drizzle_migrations`,
    );
    expect(Number((result.rows[0] as Record<string, unknown>).cnt)).toBeGreaterThanOrEqual(1);
    await fresh.pglite.close();
  });
});

// ---------------------------------------------------------------------------
// CRUD query tests (using PGlite)
// ---------------------------------------------------------------------------

describe("books CRUD", () => {
  it("inserts a book with defaults", async () => {
    const [book] = await db.insert(schema.books).values({}).returning();

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
    const [book] = await db.insert(schema.books).values({ title: "Old" }).returning();
    const [updated] = await db
      .update(schema.books)
      .set({ title: "New", status: "organized" })
      .where(eq(schema.books.id, book.id))
      .returning();

    expect(updated.title).toBe("New");
    expect(updated.status).toBe("organized");
  });

  it("deletes a book", async () => {
    const [book] = await db.insert(schema.books).values({}).returning();
    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const result = await db.query.books.findFirst({
      where: { id: book.id },
    });
    expect(result).toBeUndefined();
  });

  it("queries with relational API", async () => {
    const [book] = await db.insert(schema.books).values({ title: "Rel Test" }).returning();
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
    const [book] = await db.insert(schema.books).values({ title: "With Files" }).returning();
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
    const [book] = await db.insert(schema.books).values({ title: "With Candidates" }).returning();
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

describe("bookFiles CRUD", () => {
  it("inserts a file linked to a book", async () => {
    const [book] = await db.insert(schema.books).values({}).returning();
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
    const [book] = await db.insert(schema.books).values({}).returning();
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

describe("bookMetadataCandidates CRUD", () => {
  it("inserts metadata candidate with jsonb", async () => {
    const [book] = await db.insert(schema.books).values({}).returning();
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
    const [book] = await db.insert(schema.books).values({}).returning();
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
    const [book1] = await db.insert(schema.books).values({}).returning();
    const [book2] = await db.insert(schema.books).values({}).returning();

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
    const [book] = await db.insert(schema.books).values({}).returning();
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

describe("readingProgress CRUD", () => {
  it("inserts reading progress", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "insert-progress-test-hash",
        label: "Insert Progress Test Key",
      })
      .returning();

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
        apiKeyId: testKey.id,
      })
      .returning();

    expect(progress.document).toBe("book.epub");
    expect(progress.percentage).toBe("0.4200");
    expect(progress.timestamp).toBe(1234567890n);
  });

  it("enforces unique constraint on (apiKeyId, document, device)", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "unique-constraint-test-hash",
        label: "Constraint Test Key",
      })
      .returning();

    await db.insert(schema.readingProgress).values({
      document: "book.epub",
      device: "Kindle",
      progress: "10%",
      apiKeyId: testKey.id,
    });

    await expect(
      db.insert(schema.readingProgress).values({
        document: "book.epub",
        device: "Kindle",
        progress: "20%",
        apiKeyId: testKey.id,
      }),
    ).rejects.toThrow();
  });

  it("allows same document on different devices", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "diff-devices-test-hash",
        label: "Diff Devices Test Key",
      })
      .returning();

    await db.insert(schema.readingProgress).values({
      document: "shared.epub",
      device: "Kindle",
      progress: "10%",
      apiKeyId: testKey.id,
    });
    await db.insert(schema.readingProgress).values({
      document: "shared.epub",
      device: "iPad",
      progress: "20%",
      apiKeyId: testKey.id,
    });

    const all = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.document, "shared.epub"));
    expect(all).toHaveLength(2);
  });

  it("stores nullable book_id on reading progress", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "nullable-book-test-hash",
        label: "Nullable Book Test Key",
      })
      .returning();

    const [progress] = await db
      .insert(schema.readingProgress)
      .values({ document: "hash.epub", device: "KoReader", progress: "5%", apiKeyId: testKey.id })
      .returning();
    expect(progress.bookId).toBeNull();
  });

  it("links reading progress to a book via book_id", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "linked-book-test-hash",
        label: "Linked Book Test Key",
      })
      .returning();

    const [book] = await db.insert(schema.books).values({ title: "Linked Book" }).returning();
    const [progress] = await db
      .insert(schema.readingProgress)
      .values({
        bookId: book.id,
        document: "linked.epub",
        device: "KoReader",
        progress: "20%",
        apiKeyId: testKey.id,
      })
      .returning();
    expect(progress.bookId).toBe(book.id);
  });

  it("sets book_id to null when book is deleted", async () => {
    const [testKey] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "book-delete-null-test-hash",
        label: "Book Delete Null Test Key",
      })
      .returning();

    const [book] = await db.insert(schema.books).values({ title: "To Delete" }).returning();
    await db.insert(schema.readingProgress).values({
      bookId: book.id,
      document: "orphan.epub",
      device: "KoReader",
      progress: "50%",
      apiKeyId: testKey.id,
    });

    await db.delete(schema.books).where(eq(schema.books.id, book.id));

    const [progress] = await db
      .select()
      .from(schema.readingProgress)
      .where(eq(schema.readingProgress.document, "orphan.epub"));
    expect(progress!.bookId).toBeNull();
  });
});

describe("apiKeys CRUD", () => {
  it("inserts an API key", async () => {
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "sha256_unique_hash_1",
        label: "Test Key",
      })
      .returning();

    expect(key.keyPrefix).toBe("bk_");
    expect(key.label).toBe("Test Key");
    expect(key.createdAt).toBeInstanceOf(Date);
    expect(key.lastUsedAt).toBeNull();
  });

  it("enforces unique keyHash", async () => {
    await db.insert(schema.apiKeys).values({
      keyPrefix: "bk_",
      keyHash: "duplicate_hash",
      label: "Key 1",
    });

    await expect(
      db.insert(schema.apiKeys).values({
        keyPrefix: "bk_",
        keyHash: "duplicate_hash",
        label: "Key 2",
      }),
    ).rejects.toThrow();
  });

  it("updates lastUsedAt", async () => {
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        keyPrefix: "bk_",
        keyHash: "hash_for_update",
        label: "Update Test",
      })
      .returning();

    const now = new Date();
    const [updated] = await db
      .update(schema.apiKeys)
      .set({ lastUsedAt: now })
      .where(eq(schema.apiKeys.id, key.id))
      .returning();

    expect(updated.lastUsedAt).toEqual(now);
  });
});
