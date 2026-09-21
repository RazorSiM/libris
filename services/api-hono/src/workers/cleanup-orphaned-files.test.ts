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
import { createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { __setTestDb } from "../services/db.js";
import { createCleanupOrphanedFilesProcessor } from "./cleanup-orphaned-files.js";

/**
 * `lstat` is stubbed only so a test can force the errno the filesystem would
 * otherwise have to produce. Running as root (CI containers) makes a chmod-based
 * EACCES useless, and EIO cannot be produced portably at all; the production
 * decision this suite pins is "which errno codes delete a row", not "does the
 * kernel return EACCES".
 */
const { lstatMock } = vi.hoisted(() => ({ lstatMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => lstatMock(...args),
  };
});

let actualLstat: typeof import("node:fs/promises").lstat;

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

let pglite: PGlite;
let db: TestDb;
// books.created_by is NOT NULL since the cutover, so every seeded book needs an
// owner even in suites that have nothing to do with ownership.
let ownerId: string;
let libraryRoot: string;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  ownerId = await seedUser(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  actualLstat = actual.lstat;
  lstatMock.mockImplementation(actualLstat);
});

beforeEach(async () => {
  libraryRoot = await mkdtemp(join(tmpdir(), "libris-orphan-"));
});

afterEach(async () => {
  lstatMock.mockImplementation(actualLstat);
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
    .values({
      status: "organized",
      createdBy: ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
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
  it("removes every orphan in a single pass even when batches contain deletions", async () => {
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

  it("keeps the row when lstat fails for a reason other than absence (EACCES)", async () => {
    const bookId = await seedBook();
    const keptId = await seedBookFile(bookId, "Author/Title/denied.epub");
    lstatMock.mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith("denied.epub")) {
        throw errnoError("EACCES", "permission denied");
      }
      return actualLstat(path, ...rest);
    });

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).toEqual([keptId]);
    expect(out.result).toBe("Checked 1 files, removed 0 orphaned, kept 1 unreadable");
  });

  it("keeps the row when lstat fails with EIO", async () => {
    const bookId = await seedBook();
    const keptId = await seedBookFile(bookId, "Author/Title/broken-mount.epub");
    lstatMock.mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith("broken-mount.epub")) {
        throw errnoError("EIO", "input/output error");
      }
      return actualLstat(path, ...rest);
    });

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).toEqual([keptId]);
    expect(out.result).toBe("Checked 1 files, removed 0 orphaned, kept 1 unreadable");
  });

  it("deletes the row on a confirmed ENOENT and keeps unreadable siblings", async () => {
    const bookId = await seedBook();
    const orphanId = await seedBookFile(bookId, "Author/Title/gone.epub");
    const keptId = await seedBookFile(bookId, "Author/Title/denied.epub");
    lstatMock.mockImplementation(async (path, ...rest) => {
      const target = String(path);
      if (target.endsWith("gone.epub")) {
        throw errnoError("ENOENT", "no such file or directory");
      }
      if (target.endsWith("denied.epub")) {
        throw errnoError("EACCES", "permission denied");
      }
      return actualLstat(path, ...rest);
    });

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).toEqual([keptId]);
    expect(remaining.map((r) => r.id)).not.toContain(orphanId);
    expect(out.result).toBe("Checked 2 files, removed 1 orphaned, kept 1 unreadable");
  });

  it("deletes the row on ENOTDIR (a path component is not a directory)", async () => {
    const bookId = await seedBook();
    const orphanId = await seedBookFile(bookId, "Author/Title/file.epub");
    lstatMock.mockImplementation(async (path, ...rest) => {
      if (String(path).endsWith("file.epub")) {
        throw errnoError("ENOTDIR", "not a directory");
      }
      return actualLstat(path, ...rest);
    });

    const processor = createCleanupOrphanedFilesProcessor(libraryRoot);
    const out = await processor(createMockJob());

    const remaining = await db.select({ id: schema.bookFiles.id }).from(schema.bookFiles);
    expect(remaining.map((r) => r.id)).not.toContain(orphanId);
    expect(out.result).toBe("Checked 1 files, removed 1 orphaned");
  });
});
