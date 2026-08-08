import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Db } from "../db/index.js";
import { books, readingAggregate, readingProgress, users } from "../db/schema";
import { createTestDb, seedUser, type TestDb } from "../db/test-utils";
import { upsertReadingAggregate } from "./reading-aggregate";

let pglite: PGlite;
let db: TestDb;
let userId: string;
let bookId: string;
const document = "doc-hash-1";

// PGlite and PostgresJs share the Drizzle query API but expose different driver
// session types. Tests cast to the production Db type so business-logic helpers
// can be invoked unchanged.
const asDb = (): Db => db as unknown as Db;

async function seedUserAndBook(): Promise<{ userId: string; bookId: string }> {
  const owner = await seedUser(db);
  const [book] = await db
    .insert(books)
    .values({ status: "organized", title: "Test", author: "T", createdBy: owner })
    .returning({ id: books.id });
  return { userId: owner, bookId: book!.id };
}

async function pushProgress(
  userId: string,
  bookId: string,
  device: string,
  percentage: number,
  timestamp: bigint,
): Promise<void> {
  await db.insert(readingProgress).values({
    userId,
    bookId,
    document,
    device,
    deviceId: device,
    progress: "0/100",
    percentage: percentage.toFixed(4),
    timestamp,
  });
}

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

afterEach(async () => {
  await db.delete(readingAggregate);
  await db.delete(readingProgress);
  await db.delete(books);
  await db.delete(users);
});

describe("upsertReadingAggregate", () => {
  it("seeds startedAt from the earliest non-zero progress row", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    await pushProgress(userId, bookId, "phone", 0.1, 1000n);
    await pushProgress(userId, bookId, "kindle", 0.2, 2000n);

    await upsertReadingAggregate(asDb(), userId, bookId, document);

    const [row] = await db.select().from(readingAggregate);
    expect(row).toBeDefined();
    expect(row!.startedAt).toEqual(new Date(1000_000));
    expect(row!.finishedAt).toBeNull();
  });

  it("seeds finishedAt only when percentage crosses FINISHED_THRESHOLD", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    await pushProgress(userId, bookId, "phone", 0.5, 1000n);

    await upsertReadingAggregate(asDb(), userId, bookId, document);
    let [row] = await db.select().from(readingAggregate);
    expect(row!.finishedAt).toBeNull();

    await pushProgress(userId, bookId, "kindle", 0.99, 5000n);
    await upsertReadingAggregate(asDb(), userId, bookId, document);
    [row] = await db.select().from(readingAggregate);
    expect(row!.finishedAt).toEqual(new Date(5000_000));
  });

  it("does not overwrite an existing startedAt or finishedAt", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    await pushProgress(userId, bookId, "phone", 0.99, 1000n);
    await upsertReadingAggregate(asDb(), userId, bookId, document);

    // Subsequent rereads — newer timestamps but values should be preserved.
    await pushProgress(userId, bookId, "kindle", 0.5, 9000n);
    await upsertReadingAggregate(asDb(), userId, bookId, document);
    const [row] = await db.select().from(readingAggregate);
    expect(row!.startedAt).toEqual(new Date(1000_000));
    expect(row!.finishedAt).toEqual(new Date(1000_000));
  });

  it("is a no-op when no row has percentage > 0", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    await pushProgress(userId, bookId, "phone", 0, 1000n);

    await upsertReadingAggregate(asDb(), userId, bookId, document);
    const rows = await db.select().from(readingAggregate);
    expect(rows).toHaveLength(0);
  });

  it("preserves manual override fields when kosync upserts new progress", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    // Seed a manual override directly.
    const manualSet = new Date("2026-04-01T00:00:00Z");
    await db.insert(readingAggregate).values({
      userId,
      bookId,
      manualStatus: "finished",
      manualStartedAt: new Date("2026-01-01T00:00:00Z"),
      manualFinishedAt: new Date("2026-02-01T00:00:00Z"),
      manualPausedAt: null,
      manualSetAt: manualSet,
    });

    // Now simulate a kosync write driving the aggregate.
    await pushProgress(userId, bookId, "phone", 0.5, 5000n);
    await upsertReadingAggregate(asDb(), userId, bookId, document);

    const [row] = await db.select().from(readingAggregate);
    // Auto fields populated by kosync.
    expect(row!.startedAt).toEqual(new Date(5000_000));
    // Manual fields untouched.
    expect(row!.manualStatus).toBe("finished");
    expect(row!.manualStartedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(row!.manualFinishedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(row!.manualSetAt).toEqual(manualSet);
  });

  it("scopes by (userId, document) — does not see other users' progress", async () => {
    ({ userId, bookId } = await seedUserAndBook());
    const other = await seedUserAndBook();
    await pushProgress(other.userId, other.bookId, "phone", 0.99, 100n);
    await pushProgress(userId, bookId, "phone", 0.5, 5000n);

    await upsertReadingAggregate(asDb(), userId, bookId, document);

    const ours = (await db.select().from(readingAggregate)).filter((r) => r.userId === userId);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.startedAt).toEqual(new Date(5000_000));
    expect(ours[0]!.finishedAt).toBeNull();
  });
});
