import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Db } from "../db/index.js";
import { apiKeys, books, readingAggregate, readingProgress } from "../db/schema";
import { createTestDb, type TestDb } from "../db/test-utils";
import { upsertReadingAggregate } from "./reading-aggregate";

let pglite: PGlite;
let db: TestDb;
let apiKeyId: string;
let bookId: string;
const document = "doc-hash-1";

// PGlite and PostgresJs share the Drizzle query API but expose different driver
// session types. Tests cast to the production Db type so business-logic helpers
// can be invoked unchanged.
const asDb = (): Db => db as unknown as Db;

async function seedKeyAndBook(): Promise<{ apiKeyId: string; bookId: string }> {
  const [key] = await db
    .insert(apiKeys)
    .values({ keyPrefix: "test", keyHash: `kh-${Math.random()}`, label: "test" })
    .returning({ id: apiKeys.id });
  const [book] = await db
    .insert(books)
    .values({ status: "organized", title: "Test", author: "T" })
    .returning({ id: books.id });
  return { apiKeyId: key!.id, bookId: book!.id };
}

async function pushProgress(
  apiKeyId: string,
  bookId: string,
  device: string,
  percentage: number,
  timestamp: bigint,
): Promise<void> {
  await db.insert(readingProgress).values({
    apiKeyId,
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
  await db.delete(apiKeys);
});

describe("upsertReadingAggregate", () => {
  it("seeds startedAt from the earliest non-zero progress row", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    await pushProgress(apiKeyId, bookId, "phone", 0.1, 1000n);
    await pushProgress(apiKeyId, bookId, "kindle", 0.2, 2000n);

    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);

    const [row] = await db.select().from(readingAggregate);
    expect(row).toBeDefined();
    expect(row!.startedAt).toEqual(new Date(1000_000));
    expect(row!.finishedAt).toBeNull();
  });

  it("seeds finishedAt only when percentage crosses FINISHED_THRESHOLD", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    await pushProgress(apiKeyId, bookId, "phone", 0.5, 1000n);

    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);
    let [row] = await db.select().from(readingAggregate);
    expect(row!.finishedAt).toBeNull();

    await pushProgress(apiKeyId, bookId, "kindle", 0.99, 5000n);
    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);
    [row] = await db.select().from(readingAggregate);
    expect(row!.finishedAt).toEqual(new Date(5000_000));
  });

  it("does not overwrite an existing startedAt or finishedAt", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    await pushProgress(apiKeyId, bookId, "phone", 0.99, 1000n);
    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);

    // Subsequent rereads — newer timestamps but values should be preserved.
    await pushProgress(apiKeyId, bookId, "kindle", 0.5, 9000n);
    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);
    const [row] = await db.select().from(readingAggregate);
    expect(row!.startedAt).toEqual(new Date(1000_000));
    expect(row!.finishedAt).toEqual(new Date(1000_000));
  });

  it("is a no-op when no row has percentage > 0", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    await pushProgress(apiKeyId, bookId, "phone", 0, 1000n);

    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);
    const rows = await db.select().from(readingAggregate);
    expect(rows).toHaveLength(0);
  });

  it("preserves manual override fields when kosync upserts new progress", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    // Seed a manual override directly.
    const manualSet = new Date("2026-04-01T00:00:00Z");
    await db.insert(readingAggregate).values({
      apiKeyId,
      bookId,
      manualStatus: "finished",
      manualStartedAt: new Date("2026-01-01T00:00:00Z"),
      manualFinishedAt: new Date("2026-02-01T00:00:00Z"),
      manualPausedAt: null,
      manualSetAt: manualSet,
    });

    // Now simulate a kosync write driving the aggregate.
    await pushProgress(apiKeyId, bookId, "phone", 0.5, 5000n);
    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);

    const [row] = await db.select().from(readingAggregate);
    // Auto fields populated by kosync.
    expect(row!.startedAt).toEqual(new Date(5000_000));
    // Manual fields untouched.
    expect(row!.manualStatus).toBe("finished");
    expect(row!.manualStartedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(row!.manualFinishedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
    expect(row!.manualSetAt).toEqual(manualSet);
  });

  it("scopes by (apiKeyId, document) — does not see other users' progress", async () => {
    ({ apiKeyId, bookId } = await seedKeyAndBook());
    const other = await seedKeyAndBook();
    await pushProgress(other.apiKeyId, other.bookId, "phone", 0.99, 100n);
    await pushProgress(apiKeyId, bookId, "phone", 0.5, 5000n);

    await upsertReadingAggregate(asDb(), apiKeyId, bookId, document);

    const ours = (await db.select().from(readingAggregate)).filter((r) => r.apiKeyId === apiKeyId);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.startedAt).toEqual(new Date(5000_000));
    expect(ours[0]!.finishedAt).toBeNull();
  });
});
