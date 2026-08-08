import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { __setTestDb } from "../services/db.js";
import { createBookParseFileProcessor } from "./book-parse-file.js";

const { extractEpubMetadata, extractEpubTextSample } = vi.hoisted(() => ({
  extractEpubMetadata: vi.fn(),
  extractEpubTextSample: vi.fn(),
}));

vi.mock("../lib/metadata/index.js", () => ({
  extractEpubMetadata,
  extractEpubTextSample,
}));

let pglite: PGlite;
let db: TestDb;
// books.created_by is NOT NULL since the cutover, so every seeded book needs an
// owner even in suites that have nothing to do with ownership.
let ownerId: string;
let inboxPath: string;
let filePath: string;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  ownerId = await seedUser(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
  inboxPath = await mkdtemp(join(tmpdir(), "libris-parse-inbox-"));
  filePath = join(inboxPath, "test.epub");
  await writeFile(filePath, "test epub");
});

afterEach(async () => {
  extractEpubMetadata.mockReset();
  extractEpubTextSample.mockReset();
  await db.delete(schema.bookMetadataCandidates);
  await db.delete(schema.bookFiles);
  await db.delete(schema.books);
});

afterAll(async () => {
  await pglite.close();
  await rm(inboxPath, { recursive: true, force: true });
});

function createMockQueue() {
  const add = vi.fn().mockResolvedValue({});
  return {
    add,
    queue: { add } as never,
  };
}

function createMockJob(data: Record<string, unknown>) {
  return {
    data,
    log: vi.fn().mockResolvedValue(undefined),
  } as never;
}

async function seedInboxBook() {
  const [book] = await db
    .insert(schema.books)
    .values({ status: "inbox", createdBy: ownerId, createdAt: new Date(), updatedAt: new Date() })
    .returning({ id: schema.books.id });

  const [bookFile] = await db
    .insert(schema.bookFiles)
    .values({
      bookId: book.id,
      format: "epub",
      originalName: "test.epub",
      inboxPath: filePath,
      fileSize: 123,
    })
    .returning({ id: schema.bookFiles.id });

  return { bookId: book.id, bookFileId: bookFile.id };
}

describe("createBookParseFileProcessor", () => {
  it("rejects a queued path outside the inbox before reading metadata", async () => {
    const { bookId, bookFileId } = await seedInboxBook();
    const { queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await expect(
      processor(createMockJob({ bookId, bookFileId, filePath: "/etc/passwd", format: "epub" })),
    ).rejects.toThrow(/outside the inbox/i);
    expect(extractEpubMetadata).not.toHaveBeenCalled();
  });

  it("moves a metadata-empty EPUB to manual review without queueing external lookup", async () => {
    extractEpubMetadata.mockResolvedValue({});

    const { bookId, bookFileId } = await seedInboxBook();
    const { add, queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await processor(
      createMockJob({
        bookId,
        bookFileId,
        filePath,
        format: "epub",
      }),
    );

    expect(add).not.toHaveBeenCalled();

    const [book] = await db
      .select({ status: schema.books.status })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    expect(book?.status).toBe("review");

    const candidates = await db
      .select({ source: schema.bookMetadataCandidates.source })
      .from(schema.bookMetadataCandidates)
      .where(eq(schema.bookMetadataCandidates.bookId, bookId));

    expect(candidates).toHaveLength(0);
  });

  it("queues external metadata lookup when searchable metadata exists", async () => {
    extractEpubMetadata.mockResolvedValue({
      title: "The Art of Testing",
      author: "Jane Example",
    });

    const { bookId, bookFileId } = await seedInboxBook();
    const { add, queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await processor(
      createMockJob({
        bookId,
        bookFileId,
        filePath,
        format: "epub",
      }),
    );

    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("fetch-metadata", {
      bookId,
      searchQuery: "The Art of Testing by Jane Example",
    });

    const [book] = await db
      .select({
        status: schema.books.status,
        title: schema.books.title,
        author: schema.books.author,
      })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    expect(book).toEqual({
      status: "inbox",
      title: "The Art of Testing",
      author: "Jane Example",
    });

    const candidates = await db
      .select({ source: schema.bookMetadataCandidates.source })
      .from(schema.bookMetadataCandidates)
      .where(eq(schema.bookMetadataCandidates.bookId, bookId));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("file");
  });

  it("stores the normalized language from the embedded tag", async () => {
    extractEpubMetadata.mockResolvedValue({
      title: "Romeo and Juliet",
      author: "William Shakespeare",
      language: "en-GB",
    });

    const { bookId, bookFileId } = await seedInboxBook();
    const { queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await processor(createMockJob({ bookId, bookFileId, filePath, format: "epub" }));

    const [book] = await db
      .select({ language: schema.books.language })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    expect(book?.language).toBe("en");
  });

  it("detects the language from text when the tag is missing", async () => {
    extractEpubMetadata.mockResolvedValue({
      title: "A Study in Scarlet",
      author: "Arthur Conan Doyle",
      description:
        "The quick brown fox jumps over the lazy dog. A clearly English description about a detective story set in London.",
    });

    const { bookId, bookFileId } = await seedInboxBook();
    const { queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await processor(createMockJob({ bookId, bookFileId, filePath, format: "epub" }));

    const [book] = await db
      .select({ language: schema.books.language })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    expect(book?.language).toBe("en");
  });

  it("prefers language detected from book body text over the metadata text", async () => {
    // English-looking title/description, but the body prose is Italian.
    extractEpubMetadata.mockResolvedValue({
      title: "An English Sounding Title",
      author: "Some Author",
      description: "An English description of the book for the catalogue.",
    });
    extractEpubTextSample.mockResolvedValue(
      "Questo e un libro molto interessante che parla della storia e della cultura italiana nel corso dei secoli passati.",
    );

    const { bookId, bookFileId } = await seedInboxBook();
    const { queue } = createMockQueue();
    const processor = createBookParseFileProcessor(queue, inboxPath);

    await processor(createMockJob({ bookId, bookFileId, filePath, format: "epub" }));

    const [book] = await db
      .select({ language: schema.books.language })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    expect(book?.language).toBe("it");
  });
});
