import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import {
  bookFiles,
  books,
  hardcoverSyncLog,
  readingProgress,
  readingProgressHistory,
} from "../src/db/schema.js";
import { findBooksToSyncToHardcover } from "../src/lib/hardcover/sync-candidates.js";
import {
  linkOrphanProgressForBook,
  reconcileOrphanProgressBookIds,
  resolveBookIdForDocument,
} from "../src/lib/progress-linking.js";

// Multi-device Hardcover sync (libris-3cw8).
//
// reading_progress.book_id is resolved from the KoReader `document` hash at
// write time. Progress that arrives before a book is organized — or that
// references a pre-embed file hash — used to be written with book_id = NULL and
// then stay invisible to Hardcover sync forever, because every sync query joins
// on rp.book_id = b.id. These tests pin the linking that recovers those rows.

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let apiKeyId: string;

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
  const { data, status } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "integration-test-key" },
  });
  expect(status).toBe(201);
  apiKeyId = data.id;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

async function seedBook(hardcoverBookId: number) {
  const [row] = await testDb
    .insert(books)
    .values({
      title: "Wintersteel",
      author: "Will Wight",
      status: "organized",
      hardcoverBookId,
    })
    .returning({ id: books.id });
  return row!.id;
}

async function seedFile(
  bookId: string,
  hashes: { contentHash?: string; originalContentHash?: string },
) {
  await testDb.insert(bookFiles).values({
    bookId,
    format: "epub",
    originalName: "book.epub",
    contentHash: hashes.contentHash ?? null,
    originalContentHash: hashes.originalContentHash ?? null,
  });
}

/** Seed one device's progress. `bookId = null` mimics an unresolved document. */
async function seedDeviceProgress(opts: {
  bookId: string | null;
  device: string;
  document: string;
  percentage: string;
}) {
  const ts = Math.floor(Date.now() / 1000);
  await testDb.insert(readingProgress).values({
    bookId: opts.bookId,
    apiKeyId,
    document: opts.document,
    device: opts.device,
    progress: "0",
    percentage: opts.percentage,
    timestamp: BigInt(ts),
  });
  await testDb.insert(readingProgressHistory).values({
    bookId: opts.bookId,
    apiKeyId,
    document: opts.document,
    device: opts.device,
    progress: "0",
    percentage: opts.percentage,
    timestamp: BigInt(ts),
    createdAt: new Date(ts * 1000),
  });
}

describe("resolveBookIdForDocument", () => {
  it("resolves via content_hash and original_content_hash, null otherwise", async () => {
    const bookId = await seedBook(100);
    await seedFile(bookId, { contentHash: "new-hash", originalContentHash: "pre-embed-hash" });

    expect(await resolveBookIdForDocument(testDb, "new-hash")).toBe(bookId);
    expect(await resolveBookIdForDocument(testDb, "pre-embed-hash")).toBe(bookId);
    expect(await resolveBookIdForDocument(testDb, "unknown-hash")).toBeNull();
  });
});

describe("linkOrphanProgressForBook", () => {
  it("links orphaned progress so the furthest device's progress becomes visible to sync", async () => {
    const bookId = await seedBook(200);

    // Device A resolved on write (book_id set) at 30%.
    await seedDeviceProgress({
      bookId,
      device: "komodo",
      document: "resolved-hash",
      percentage: "0.3000",
    });
    // Device B's document didn't resolve when it arrived (book_id NULL), but it
    // is genuinely the same book and the user read further on it — 60%.
    await seedDeviceProgress({
      bookId: null,
      device: "PB700",
      document: "late-resolved-hash",
      percentage: "0.6000",
    });

    // Before linking, sync only sees device A's 30%.
    let rows = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(Number(rows[0]!.max_percentage)).toBe(0.3);

    // Organizing the book (or re-embedding) links the orphaned rows.
    const linked = await linkOrphanProgressForBook(testDb, bookId, ["late-resolved-hash"]);
    expect(linked).toBe(1);

    // Now the furthest progress (60%) is visible to Hardcover sync.
    rows = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(Number(rows[0]!.max_percentage)).toBe(0.6);
  });

  it("is idempotent and ignores already-linked rows and unknown hashes", async () => {
    const bookId = await seedBook(201);
    await seedDeviceProgress({
      bookId: null,
      device: "PB700",
      document: "doc-x",
      percentage: "0.5000",
    });

    expect(await linkOrphanProgressForBook(testDb, bookId, ["doc-x"])).toBe(1);
    // Second run links nothing (already set); unknown hashes link nothing.
    expect(await linkOrphanProgressForBook(testDb, bookId, ["doc-x"])).toBe(0);
    expect(await linkOrphanProgressForBook(testDb, bookId, ["nope"])).toBe(0);
  });
});

describe("reconcileOrphanProgressBookIds", () => {
  it("links every orphan whose document matches a stored file hash", async () => {
    const bookId = await seedBook(300);
    await seedFile(bookId, { contentHash: "ch", originalContentHash: "och" });

    await seedDeviceProgress({ bookId: null, device: "d1", document: "ch", percentage: "0.40" });
    await seedDeviceProgress({ bookId: null, device: "d2", document: "och", percentage: "0.50" });
    // A genuinely unmatched document (e.g. a sideloaded copy) cannot be linked.
    await seedDeviceProgress({
      bookId: null,
      device: "d3",
      document: "stranger",
      percentage: "0.99",
    });

    const { progress, history } = await reconcileOrphanProgressBookIds(testDb);
    expect(progress).toBe(2);
    expect(history).toBe(2);

    // The two matchable rows now drive sync (max 0.50); the stranger stays orphaned.
    const rows = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.max_percentage)).toBe(0.5);

    const stillOrphan = await testDb
      .select({ id: readingProgress.id, bookId: readingProgress.bookId })
      .from(readingProgress)
      .where(eq(readingProgress.document, "stranger"));
    expect(stillOrphan).toHaveLength(1);
    expect(stillOrphan[0]!.bookId).toBeNull();
  });
});

describe("inherent limit", () => {
  it("progress whose document matches no file stays invisible (cannot be attributed)", async () => {
    const bookId = await seedBook(400);
    await seedDeviceProgress({
      bookId,
      device: "komodo",
      document: "resolved",
      percentage: "0.3000",
    });
    await testDb.insert(hardcoverSyncLog).values({
      apiKeyId,
      bookId,
      hardcoverUserBookId: 9,
      lastStatus: "reading",
      lastProgress: "0.3000",
      lastSyncedAt: new Date(),
    });
    // Reading advanced only on a device with an unattributable document hash.
    await seedDeviceProgress({
      bookId: null,
      device: "CrossPoint",
      document: "unattributable",
      percentage: "0.6000",
    });

    // Nothing matches that hash, so it can't be linked and sync sees no change.
    const { progress } = await reconcileOrphanProgressBookIds(testDb);
    expect(progress).toBe(0);
    const rows = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(rows).toHaveLength(0);
  });
});
