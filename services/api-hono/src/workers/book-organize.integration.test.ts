/**
 * Regression coverage for the organize worker's file handling.
 *
 * The pre-fix worker built the destination from author/title/basename alone and
 * moved with `rename`, which silently replaces an existing path. Two books with
 * the same metadata and filename therefore shared one file, and a retry after
 * "moved but the database update failed" could not recover. These run the real
 * worker against a real database and filesystem.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { __setTestEnv, type Env } from "../env.js";
import { computeChecksumFromBuffer } from "../shared/checksum.js";
import { __setTestDb } from "../services/db.js";
import { bookDirectorySuffix, processBookOrganize, sanitizeName } from "./book-organize.js";

const { embedEpubMetadata, fetchExternalImage } = vi.hoisted(() => ({
  embedEpubMetadata: vi.fn(async () => {}),
  fetchExternalImage: vi.fn(),
}));

vi.mock("../lib/epub/embed-metadata.js", () => ({ embedEpubMetadata }));
vi.mock("../shared/secure-image-fetch.js", () => ({ fetchExternalImage }));

let pglite: PGlite;
let db: TestDb;
let ownerId: string;
let libraryPath: string;
let inboxRoot: string;

function testEnv(): Env {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "pglite://",
    REDIS_URL: "redis://localhost:6379",
    LIBRIS_INBOX_PATH: inboxRoot,
    LIBRIS_LIBRARY_PATH: libraryPath,
    LIBRIS_COVER_FETCH_ALLOWLIST: [],
    API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
    BETTER_AUTH_URL: "",
    LIBRIS_COOKIE_SECURE: "0",
    MIGRATIONS_PATH: "./migrations",
    TRUST_PROXY_HEADERS: "0",
    LIBRIS_TRUSTED_PROXIES: [],
    E2E_TEST: "",
    LOG_LEVEL: "info",
    LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
    LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
    LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
    LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
    LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
    LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
    LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
    LIBRIS_MAX_UPLOAD_BYTES: 1024 * 1024 * 1024,
    LIBRIS_MAX_UPLOAD_FILES: 20,
    LIBRIS_MAX_EMBED_OPF_BYTES: 1024 * 1024,
    LIBRIS_EMBED_TIMEOUT_MS: 30_000,
  };
}

beforeAll(async () => {
  inboxRoot = await mkdtemp(join(tmpdir(), "libris-organize-inbox-"));
  libraryPath = await mkdtemp(join(tmpdir(), "libris-organize-library-"));
  __setTestEnv(testEnv());

  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  ownerId = await seedUser(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
});

afterEach(async () => {
  embedEpubMetadata.mockClear();
  fetchExternalImage.mockReset();
  await db.delete(schema.bookFiles);
  await db.delete(schema.books);
});

afterAll(async () => {
  await pglite.close();
  await Promise.all([
    rm(inboxRoot, { recursive: true, force: true }),
    rm(libraryPath, { recursive: true, force: true }),
  ]);
});

function job(data: Record<string, unknown>) {
  return { data, log: vi.fn().mockResolvedValue(undefined) } as never;
}

let seedSeq = 0;

async function seedBook(options: {
  title?: string;
  author?: string;
  status?: "inbox" | "review" | "organized";
  coverUrl?: string | null;
}) {
  seedSeq += 1;
  const [book] = await db
    .insert(schema.books)
    .values({
      status: options.status ?? "review",
      title: options.title ?? "Collision",
      author: options.author ?? "Same Author",
      coverUrl: options.coverUrl ?? null,
      createdBy: ownerId,
    })
    .returning({ id: schema.books.id });
  return book.id;
}

async function seedInboxFile(bookId: string, fileName: string, content: string) {
  const dir = await mkdtemp(join(inboxRoot, `upload-${seedSeq}-`));
  const path = join(dir, fileName);
  await writeFile(path, content);
  const checksum = computeChecksumFromBuffer(Buffer.from(content));
  const [row] = await db
    .insert(schema.bookFiles)
    .values({
      bookId,
      format: "epub",
      originalName: fileName,
      inboxPath: path,
      fileSize: Buffer.byteLength(content),
      checksum,
    })
    .returning({ id: schema.bookFiles.id });
  return { id: row.id, path, checksum };
}

async function storagePathFor(bookId: string): Promise<string | null> {
  const [row] = await db
    .select({ storagePath: schema.bookFiles.storagePath })
    .from(schema.bookFiles)
    .where(eq(schema.bookFiles.bookId, bookId));
  return row?.storagePath ?? null;
}

describe("processBookOrganize destination isolation", () => {
  it("keeps both files when two books share metadata and filename", async () => {
    const bookA = await seedBook({ title: "Collision", author: "Same Author" });
    const bookB = await seedBook({ title: "Collision", author: "Same Author" });
    await seedInboxFile(bookA, "book.epub", "BOOK-A");
    await seedInboxFile(bookB, "book.epub", "BOOK-B");

    await processBookOrganize(job({ bookId: bookA }));
    await processBookOrganize(job({ bookId: bookB }));

    const pathA = await storagePathFor(bookA);
    const pathB = await storagePathFor(bookB);
    expect(pathA).toBeTruthy();
    expect(pathB).toBeTruthy();
    expect(pathA).not.toBe(pathB);
    expect(await readFile(join(libraryPath, pathA!), "utf8")).toBe("BOOK-A");
    expect(await readFile(join(libraryPath, pathB!), "utf8")).toBe("BOOK-B");
  });

  it("keeps both files when the two organizes run concurrently", async () => {
    const bookA = await seedBook({ title: "Concurrent", author: "Same Author" });
    const bookB = await seedBook({ title: "Concurrent", author: "Same Author" });
    await seedInboxFile(bookA, "book.epub", "CONCURRENT-A");
    await seedInboxFile(bookB, "book.epub", "CONCURRENT-B");

    await Promise.all([
      processBookOrganize(job({ bookId: bookA })),
      processBookOrganize(job({ bookId: bookB })),
    ]);

    const pathA = await storagePathFor(bookA);
    const pathB = await storagePathFor(bookB);
    expect(pathA).not.toBe(pathB);
    expect(await readFile(join(libraryPath, pathA!), "utf8")).toBe("CONCURRENT-A");
    expect(await readFile(join(libraryPath, pathB!), "utf8")).toBe("CONCURRENT-B");
  });

  it("puts each book in an id-suffixed directory under the same author/title", async () => {
    const bookId = await seedBook({ title: "Suffixed", author: "Same Author" });
    await seedInboxFile(bookId, "book.epub", "SUFFIXED");

    await processBookOrganize(job({ bookId }));

    const storagePath = await storagePathFor(bookId);
    expect(storagePath).toBe(
      join(
        sanitizeName("Same Author"),
        `${sanitizeName("Suffixed")} (${bookDirectorySuffix(bookId)})`,
        "book.epub",
      ),
    );
  });
});

describe("processBookOrganize retry recovery", () => {
  it("adopts a verified destination when the database update never landed", async () => {
    const bookId = await seedBook({ title: "Recovered", author: "Same Author" });
    const seeded = await seedInboxFile(bookId, "book.epub", "RECOVER-ME");

    const first = await processBookOrganize(job({ bookId }));
    expect(first).toBeUndefined();

    // Simulate the crash window: the move happened, the database update did not.
    await db
      .update(schema.bookFiles)
      .set({ inboxPath: seeded.path, storagePath: null, contentHash: null })
      .where(eq(schema.bookFiles.id, seeded.id));

    await expect(processBookOrganize(job({ bookId }))).resolves.toBeUndefined();

    const [row] = await db
      .select({
        storagePath: schema.bookFiles.storagePath,
        inboxPath: schema.bookFiles.inboxPath,
      })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.id, seeded.id));
    expect(row.storagePath).toBeTruthy();
    expect(row.inboxPath).toBeNull();
    expect(await readFile(join(libraryPath, row.storagePath!), "utf8")).toBe("RECOVER-ME");
  });

  it("refuses to adopt a destination whose content does not match", async () => {
    const bookId = await seedBook({ title: "Mismatch", author: "Same Author" });
    const destDir = join(
      libraryPath,
      sanitizeName("Same Author"),
      `${sanitizeName("Mismatch")} (${bookDirectorySuffix(bookId)})`,
    );
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "book.epub"), "SOMEBODY-ELSE");

    await db.insert(schema.bookFiles).values({
      bookId,
      format: "epub",
      originalName: "book.epub",
      inboxPath: join(inboxRoot, "never-existed", "book.epub"),
      fileSize: 6,
      checksum: computeChecksumFromBuffer(Buffer.from("THE-REAL-BYTES")),
    });

    await expect(processBookOrganize(job({ bookId }))).rejects.toThrow(/Source file not found/);
    expect(await storagePathFor(bookId)).toBeNull();
    expect(await readFile(join(destDir, "book.epub"), "utf8")).toBe("SOMEBODY-ELSE");
  });
});

describe("processBookOrganize cover replacement", () => {
  it("keeps the existing cover when a forced re-download fails", async () => {
    const bookId = await seedBook({
      title: "Covered",
      author: "Same Author",
      status: "organized",
      coverUrl: "https://example.com/cover.jpg",
    });
    const destDir = join(
      libraryPath,
      sanitizeName("Same Author"),
      `${sanitizeName("Covered")} (${bookDirectorySuffix(bookId)})`,
    );
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "book.epub"), "BOOK-BYTES");
    await writeFile(join(destDir, "cover.jpg"), "OLD-COVER");

    await db.insert(schema.bookFiles).values({
      bookId,
      format: "epub",
      originalName: "book.epub",
      storagePath: relative(libraryPath, join(destDir, "book.epub")),
      fileSize: 10,
      checksum: computeChecksumFromBuffer(Buffer.from("BOOK-BYTES")),
    });
    const coverStoragePath = relative(libraryPath, join(destDir, "cover.jpg"));
    await db
      .update(schema.books)
      .set({ coverPath: coverStoragePath })
      .where(eq(schema.books.id, bookId));

    fetchExternalImage.mockRejectedValue(new Error("network down"));

    await processBookOrganize(job({ bookId, forceRedownloadCover: true }));

    expect(await readFile(join(destDir, "cover.jpg"), "utf8")).toBe("OLD-COVER");
    const [book] = await db
      .select({ coverPath: schema.books.coverPath })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));
    expect(book.coverPath).toBe(coverStoragePath);
  });
});
