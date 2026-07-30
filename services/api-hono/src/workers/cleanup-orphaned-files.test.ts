import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { __setTestDb } from "../services/db.js";
import { createCleanupOrphanedFilesProcessor } from "./cleanup-orphaned-files.js";

let pglite: PGlite;
let db: TestDb;
let libraryRoot: string;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
});

beforeEach(async () => {
  libraryRoot = await mkdtemp(join(tmpdir(), "libris-orphan-"));
});

afterEach(async () => {
  await db.delete(schema.bookFiles);
  await db.delete(schema.books);
  await rm(libraryRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await pglite.close();
});

function createMockJob() {
  return { log: vi.fn().mockResolvedValue(undefined) } as never;
}

async function seedBook() {
  const [book] = await db
    .insert(schema.books)
    .values({ status: "organized", createdAt: new Date(), updatedAt: new Date() })
    .returning({ id: schema.books.id });
  return book.id;
}

async function seedBookFile(bookId: string, storagePath: string | null) {
  const [row] = await db
    .insert(schema.bookFiles)
    .values({
      bookId,
      format: "epub",
      originalName: storagePath ? storagePath.split("/").pop()! : "no-storage.epub",
      storagePath,
      fileSize: 0,
    })
    .returning({ id: schema.bookFiles.id });
  return row.id;
}

async function materialize(relPath: string) {
  const full = join(libraryRoot, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, "x");
}

describe("createCleanupOrphanedFilesProcessor", () => {
  it("removes every orphan in a single pass even when batches contain deletions (regression for libris-434)", async () => {
    // Seed enough rows to span multiple small batches. With BATCH_SIZE=10 and
    // an even split, the buggy offset-based loop would skip rows after each
    // delete; this test fails against that implementation.
    const bookId = await seedBook();
    const total = 50;
    const expectedSurvivors: string[] = [];
    const expectedDeleted: string[] = [];

    for (let i = 0; i < total; i++) {
      const relPath = `Author/Title/book-${i.toString().padStart(3, "0")}.epub`;
      const id = await seedBookFile(bookId, relPath);
      if (i % 2 === 0) {
        // even index: file exists on disk -> survives
        await materialize(relPath);
        expectedSurvivors.push(id);
      } else {
        // odd index: file missing -> orphan
        expectedDeleted.push(id);
      }
    }

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot, { batchSize: 10 });
    const job = createMockJob();
    const out = await processor(job);

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    const remainingIds = remaining.map((r) => r.id).sort();

    expect(remainingIds).toEqual([...expectedSurvivors].sort());
    for (const deletedId of expectedDeleted) {
      expect(remainingIds).not.toContain(deletedId);
    }
    expect(out.result).toBe(`Checked ${total} files, removed ${expectedDeleted.length} orphaned`);
  });

  it("keeps rows whose storage_path file still exists", async () => {
    const bookId = await seedBook();
    const keepId = await seedBookFile(bookId, "Author/Title/keep.epub");
    await materialize("Author/Title/keep.epub");

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).toEqual([keepId]);
  });

  it("ignores rows with NULL storage_path", async () => {
    const bookId = await seedBook();
    const nullId = await seedBookFile(bookId, null);
    const orphanId = await seedBookFile(bookId, "Author/Title/missing.epub");

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).toEqual([nullId]);
    expect(remaining.map((r) => r.id)).not.toContain(orphanId);
    expect(out.result).toBe("Checked 1 files, removed 1 orphaned");
  });

  it("returns zero counts when there is nothing to scan", async () => {
    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());
    expect(out.result).toBe("Checked 0 files, removed 0 orphaned");
  });
});
