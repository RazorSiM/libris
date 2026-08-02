import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { bootstrapAdmin, createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import {
  books,
  hardcoverSyncLog,
  readingAggregate,
  readingProgress,
  readingProgressHistory,
} from "../src/db/schema.js";
import { findBooksToSyncToHardcover } from "../src/lib/hardcover/sync-candidates.js";

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: Awaited<ReturnType<typeof createTestApp>>["services"];
let userId: string;

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
  ({ userId } = await bootstrapAdmin(services, $fetchRaw));
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

async function seedBook(opts: {
  title?: string;
  hardcoverBookId?: number | null;
  status?: "organized" | "review" | "inbox";
}) {
  const [row] = await testDb
    .insert(books)
    .values({
      createdBy: userId,
      title: opts.title ?? "Test Book",
      author: "Author",
      status: opts.status ?? "organized",
      hardcoverBookId: opts.hardcoverBookId ?? null,
    })
    .returning({ id: books.id });
  return row!.id;
}

async function seedProgress(bookId: string, percentage: string, daysAgo = 0) {
  const ts = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  await testDb.insert(readingProgress).values({
    bookId,
    userId,
    document: `doc-${bookId}`,
    device: "test-device",
    progress: "0",
    percentage,
    timestamp: BigInt(ts),
  });
  await testDb.insert(readingProgressHistory).values({
    bookId,
    userId,
    document: `doc-${bookId}`,
    device: "test-device",
    progress: "0",
    percentage,
    timestamp: BigInt(ts),
    createdAt: new Date(ts * 1000),
  });
}

async function seedManualStatus(
  bookId: string,
  manualStatus: "unread" | "reading" | "finished" | "paused",
) {
  await testDb.insert(readingAggregate).values({
    userId,
    bookId,
    manualStatus,
    manualSetAt: new Date(),
  });
}

describe("findBooksToSyncToHardcover", () => {
  it("excludes books without a hardcover_book_id", async () => {
    const bookId = await seedBook({ hardcoverBookId: null });
    await seedProgress(bookId, "0.5000");

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(0);
  });

  it("includes a book with local progress when sync log is missing", async () => {
    const bookId = await seedBook({ hardcoverBookId: 100 });
    await seedProgress(bookId, "0.5000");

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.book_id).toBe(bookId);
    expect(rows[0]!.manual_status).toBeNull();
  });

  it("includes a manual-only book even when there is no local progress", async () => {
    const bookId = await seedBook({ hardcoverBookId: 200 });
    await seedManualStatus(bookId, "finished");

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.book_id).toBe(bookId);
    expect(rows[0]!.manual_status).toBe("finished");
    expect(rows[0]!.max_percentage).toBeNull();
  });

  it("excludes a manual-only book when sync log already matches the manual status", async () => {
    const bookId = await seedBook({ hardcoverBookId: 200 });
    await seedManualStatus(bookId, "finished");
    await testDb.insert(hardcoverSyncLog).values({
      userId,
      bookId,
      hardcoverUserBookId: 999,
      lastStatus: "finished",
      lastProgress: null,
      lastSyncedAt: new Date(),
    });

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(0);
  });

  it("re-includes a book when manual_status diverges from sync log", async () => {
    const bookId = await seedBook({ hardcoverBookId: 200 });
    await seedManualStatus(bookId, "paused");
    await testDb.insert(hardcoverSyncLog).values({
      userId,
      bookId,
      hardcoverUserBookId: 999,
      lastStatus: "reading",
      lastProgress: null,
      lastSyncedAt: new Date(),
    });

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.manual_status).toBe("paused");
    expect(rows[0]!.last_status).toBe("reading");
  });

  it("manual_status wins over computed when both exist (change detection compares against effective)", async () => {
    const bookId = await seedBook({ hardcoverBookId: 200 });
    await seedProgress(bookId, "0.5000"); // would compute as 'reading'
    await seedManualStatus(bookId, "finished");
    // Sync log already says 'finished' — effective is 'finished' (from manual),
    // so even though computed would be 'reading', no diff.
    await testDb.insert(hardcoverSyncLog).values({
      userId,
      bookId,
      hardcoverUserBookId: 999,
      lastStatus: "finished",
      lastProgress: "0.5000",
      lastSyncedAt: new Date(),
    });

    const rows = await findBooksToSyncToHardcover(testDb, userId);
    expect(rows).toHaveLength(0);
  });

  it("only returns rows for the given api key", async () => {
    const bookId = await seedBook({ hardcoverBookId: 200 });
    await seedManualStatus(bookId, "finished");

    // Same DB, unknown userId — should see no candidates because the
    // manual-status row is scoped to a different api_key_id.
    const otherApiKeyId = "00000000-0000-0000-0000-000000000000";
    const rowsOther = await findBooksToSyncToHardcover(testDb, otherApiKeyId);
    expect(rowsOther).toHaveLength(0);

    const rowsSelf = await findBooksToSyncToHardcover(testDb, userId);
    expect(rowsSelf).toHaveLength(1);
  });
});
