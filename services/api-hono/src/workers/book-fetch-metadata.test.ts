import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createTestDb, seedUser, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { __setTestDb } from "../services/db.js";
import { processBookFetchMetadata } from "./book-fetch-metadata.js";

const { searchHardcover } = vi.hoisted(() => ({
  searchHardcover: vi.fn(),
}));

vi.mock("../lib/metadata/index.js", () => ({
  searchHardcover,
}));

let pglite: PGlite;
let db: TestDb;
// books.created_by is NOT NULL since the cutover, so every seeded book needs an
// owner even in suites that have nothing to do with ownership.
let ownerId: string;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  ownerId = await seedUser(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
});

afterEach(async () => {
  searchHardcover.mockReset();
  await db.delete(schema.bookMetadataCandidates);
  await db.delete(schema.bookFiles);
  await db.delete(schema.books);
});

afterAll(async () => {
  await pglite.close();
});

function createMockJob(data: Record<string, unknown>) {
  return {
    data,
    log: vi.fn().mockResolvedValue(undefined),
  } as never;
}

/**
 * Seed a book exactly as parse-file leaves it before fetch-metadata runs:
 * status "inbox" with a single file-derived metadata candidate.
 */
async function seedBookAwaitingMetadata() {
  const [book] = await db
    .insert(schema.books)
    .values({
      status: "inbox",
      createdBy: ownerId,
      title: "La vasca del Führer",
      author: "Serena Dandini",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: schema.books.id });

  await db.insert(schema.bookMetadataCandidates).values({
    bookId: book.id,
    source: "file",
    rawResponse: null,
    normalized: { title: "La vasca del Führer", author: "Serena Dandini" },
    confidence: "1.00",
  });

  return book.id;
}

async function getStatus(bookId: string) {
  const [book] = await db
    .select({ status: schema.books.status })
    .from(schema.books)
    .where(eq(schema.books.id, bookId));
  return book?.status;
}

describe("processBookFetchMetadata", () => {
  it("promotes a book to review when Hardcover returns no results (file metadata only)", async () => {
    // Regression: a book whose automatic Hardcover query misses must not be
    // stranded in "inbox" — it already has a file candidate and is approvable.
    searchHardcover.mockResolvedValue([]);

    const bookId = await seedBookAwaitingMetadata();

    await processBookFetchMetadata(
      createMockJob({ bookId, searchQuery: "La vasca del Führer by Serena Dandini" }),
    );

    expect(await getStatus(bookId)).toBe("review");

    // No external candidate is invented — only the original file candidate remains.
    const candidates = await db
      .select({ source: schema.bookMetadataCandidates.source })
      .from(schema.bookMetadataCandidates)
      .where(eq(schema.bookMetadataCandidates.bookId, bookId));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("file");
  });

  it("inserts the hardcover candidate and promotes to review when results exist", async () => {
    searchHardcover.mockResolvedValue([
      {
        source: "hardcover",
        rawResponse: { id: 1 },
        normalized: { title: "La vasca del Führer", isbn13: "9788806242824" },
        confidence: 0.95,
      },
    ]);

    const bookId = await seedBookAwaitingMetadata();

    await processBookFetchMetadata(
      createMockJob({ bookId, searchQuery: "La vasca del Führer by Serena Dandini" }),
    );

    expect(await getStatus(bookId)).toBe("review");

    const sources = (
      await db
        .select({ source: schema.bookMetadataCandidates.source })
        .from(schema.bookMetadataCandidates)
        .where(eq(schema.bookMetadataCandidates.bookId, bookId))
    ).map((c) => c.source);
    expect(sources).toContain("file");
    expect(sources).toContain("hardcover");
  });
});
