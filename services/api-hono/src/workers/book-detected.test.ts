import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import { computeChecksumFromBuffer } from "../shared/checksum.js";
import { generateApiKey } from "../shared/auth.js";
import { __setTestDb } from "../services/db.js";
import { createBookDetectedProcessor } from "./book-detected.js";

let pglite: PGlite;
let db: TestDb;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
});

afterEach(async () => {
  // Clean up all rows between tests to avoid cross-test interference
  await db.delete(schema.bookFiles);
  await db.delete(schema.uploadRegistry);
  await db.delete(schema.books);
  await db.delete(schema.apiKeys);
});

afterAll(async () => {
  await pglite.close();
});

/** Helper to create a mock queue that captures enqueued jobs. */
function createMockQueue() {
  const queuedJobs: Array<Record<string, unknown>> = [];
  const queue = {
    add: async (_name: string, data: Record<string, unknown>) => {
      queuedJobs.push(data);
      return {};
    },
  } as never;
  return { queuedJobs, queue };
}

/** Helper to create a mock job with given data. */
function createMockJob(data: Record<string, unknown>) {
  return {
    data,
    log: async () => {},
  } as never;
}

/** Helper to create an API key and return its DB id. */
async function createApiKey(label: string) {
  const key = await generateApiKey();
  const [apiKey] = await db
    .insert(schema.apiKeys)
    .values({
      keyPrefix: key.keyPrefix,
      keyHash: key.keyHash,
      label,
      isAdmin: false,
    })
    .returning({ id: schema.apiKeys.id });
  return apiKey;
}

describe("createBookDetectedProcessor", () => {
  it("prefers the upload registry filename over the collision-safe inbox basename", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "libris-book-detected-"));
    const filePath = join(tempDir, "same-1.epub");
    const fileContent = Buffer.from("collision-safe file");

    await writeFile(filePath, fileContent);

    const apiKey = await createApiKey("Worker Test Key");

    const checksum = computeChecksumFromBuffer(fileContent);
    await db.insert(schema.uploadRegistry).values({
      checksum,
      apiKeyId: apiKey.id,
      filename: "same.epub",
    });

    const { queuedJobs, queue } = createMockQueue();
    const processor = createBookDetectedProcessor(queue);

    await processor(createMockJob({ filePath, detectedAt: new Date().toISOString() }));

    const [book] = await db
      .select({ id: schema.books.id, createdBy: schema.books.createdBy })
      .from(schema.books);
    const [bookFile] = await db
      .select({
        originalName: schema.bookFiles.originalName,
        inboxPath: schema.bookFiles.inboxPath,
        checksum: schema.bookFiles.checksum,
      })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.bookId, book.id));

    expect(book.createdBy).toBe(apiKey.id);
    expect(bookFile).toEqual({
      originalName: "same.epub",
      inboxPath: filePath,
      checksum,
    });
    expect(queuedJobs).toHaveLength(1);

    const registryRows = await db.select().from(schema.uploadRegistry);
    expect(registryRows).toHaveLength(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("assigns ownership to the first uploader (earliest createdAt) when multiple users upload the same file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "libris-book-detected-"));
    const filePath = join(tempDir, "shared-book.epub");
    const fileContent = Buffer.from("shared file content for ownership test");

    await writeFile(filePath, fileContent);

    const firstUploader = await createApiKey("First Uploader");
    const secondUploader = await createApiKey("Second Uploader");

    const checksum = computeChecksumFromBuffer(fileContent);

    // Insert the first uploader with an earlier timestamp
    await db.insert(schema.uploadRegistry).values({
      checksum,
      apiKeyId: firstUploader.id,
      filename: "first-upload.epub",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });

    // Insert the second uploader with a later timestamp
    await db.insert(schema.uploadRegistry).values({
      checksum,
      apiKeyId: secondUploader.id,
      filename: "second-upload.epub",
      createdAt: new Date("2025-01-02T00:00:00Z"),
    });

    // Verify both rows exist before processing
    const registryBefore = await db.select().from(schema.uploadRegistry);
    expect(registryBefore).toHaveLength(2);

    const { queuedJobs, queue } = createMockQueue();
    const processor = createBookDetectedProcessor(queue);

    await processor(createMockJob({ filePath, detectedAt: new Date().toISOString() }));

    const [book] = await db
      .select({ id: schema.books.id, createdBy: schema.books.createdBy })
      .from(schema.books);

    // The first uploader (earliest createdAt) must win ownership
    expect(book.createdBy).toBe(firstUploader.id);

    const [bookFile] = await db
      .select({ originalName: schema.bookFiles.originalName })
      .from(schema.bookFiles)
      .where(eq(schema.bookFiles.bookId, book.id));

    // The filename should come from the winning (first) registry entry
    expect(bookFile.originalName).toBe("first-upload.epub");

    expect(queuedJobs).toHaveLength(1);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("cleans up all registry rows for the checksum after processing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "libris-book-detected-"));
    const filePath = join(tempDir, "cleanup-test.epub");
    const fileContent = Buffer.from("cleanup test content");

    await writeFile(filePath, fileContent);

    const userA = await createApiKey("User A");
    const userB = await createApiKey("User B");
    const userC = await createApiKey("User C");

    const checksum = computeChecksumFromBuffer(fileContent);

    // Three different users uploaded the same file
    await db.insert(schema.uploadRegistry).values([
      {
        checksum,
        apiKeyId: userA.id,
        filename: "a.epub",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
      {
        checksum,
        apiKeyId: userB.id,
        filename: "b.epub",
        createdAt: new Date("2025-01-02T00:00:00Z"),
      },
      {
        checksum,
        apiKeyId: userC.id,
        filename: "c.epub",
        createdAt: new Date("2025-01-03T00:00:00Z"),
      },
    ]);

    const registryBefore = await db.select().from(schema.uploadRegistry);
    expect(registryBefore).toHaveLength(3);

    const { queue } = createMockQueue();
    const processor = createBookDetectedProcessor(queue);

    await processor(createMockJob({ filePath, detectedAt: new Date().toISOString() }));

    // ALL registry rows for this checksum must be deleted
    const registryAfter = await db.select().from(schema.uploadRegistry);
    expect(registryAfter).toHaveLength(0);

    await rm(tempDir, { recursive: true, force: true });
  });
});
