/**
 * Upload registry flow tests.
 *
 * Tests the upload registry mechanism that tracks book ownership:
 * 1. Upload route creates a registry row with correct userId + checksum
 * 2. Book-detected worker looks up registry by checksum and sets createdBy
 * 3. Registry entry is cleaned up after ownership is recorded
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import { books, bookFiles, uploadRegistry } from "../src/db/schema.js";
import { computeChecksumFromBuffer } from "../src/shared/checksum.js";
import { createBookDetectedProcessor } from "../src/workers/book-detected.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let testApp: Awaited<ReturnType<typeof createTestApp>>;

// ── Per-test state ───────────────────────────────────────────────

let adminKey: string;
let adminKeyId: string;

function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

// ── App lifecycle ──────────────────────────────────────────────────

beforeAll(async () => {
  // Ensure the inbox directory exists for upload tests
  await mkdir("/tmp/libris-test-inbox", { recursive: true });

  testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
});

// ── Per-test lifecycle ─────────────────────────────────────────────

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });

  // Create admin key via setup (first key is always admin)
  const { data, status } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "admin-key" },
  });
  expect(status).toBe(201);
  adminKey = data.key;
  adminKeyId = data.id;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

// ── Upload registry insert via API ────────────────────────────────

describe("upload route creates registry entry", () => {
  it("POST /api/inbox/upload inserts a registry row with correct checksum and userId", async () => {
    // Create a minimal valid EPUB (just needs .epub extension for the route)
    const epubContent = Buffer.from("PK\x03\x04fake-epub-content-for-testing");
    const expectedChecksum = computeChecksumFromBuffer(epubContent);

    // Upload via multipart form
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([epubContent], { type: "application/epub+zip" }),
      "test-book.epub",
    );

    const res = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.uploaded).toHaveLength(1);
    expect(data.uploaded[0].filename).toBe("test-book.epub");

    // Verify registry row was created
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0].checksum).toBe(expectedChecksum);
    expect(registryRows[0].userId).toBe(adminKeyId);
    expect(registryRows[0].filename).toBe("test-book.epub");
  });

  it("creates separate registry entries for multiple files in one upload", async () => {
    const content1 = Buffer.from("PK\x03\x04epub-content-one");
    const content2 = Buffer.from("PK\x03\x04epub-content-two");
    const checksum1 = computeChecksumFromBuffer(content1);
    const checksum2 = computeChecksumFromBuffer(content2);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([content1], { type: "application/epub+zip" }),
      "book-one.epub",
    );
    formData.append(
      "file",
      new Blob([content2], { type: "application/epub+zip" }),
      "book-two.epub",
    );

    const res = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: formData,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.uploaded).toHaveLength(2);

    // Verify both registry rows exist
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(2);

    const checksums = registryRows.map((r) => r.checksum).sort();
    expect(checksums).toEqual([checksum1, checksum2].sort());

    // Both should reference the admin key
    for (const row of registryRows) {
      expect(row.userId).toBe(adminKeyId);
    }
  });

  it("associates registry entry with the correct non-admin user", async () => {
    // Create a non-admin key
    const { data: userData } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "regular-user" },
      headers: adminAuth(),
    });
    const userKey = userData.key;
    const userKeyId = userData.id;

    const epubContent = Buffer.from("PK\x03\x04user-uploaded-epub");
    const expectedChecksum = computeChecksumFromBuffer(epubContent);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([epubContent], { type: "application/epub+zip" }),
      "user-book.epub",
    );

    const res = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${userKey}` },
      body: formData,
    });

    expect(res.status).toBe(200);

    // Verify the registry entry belongs to the regular user, not admin
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0].userId).toBe(userKeyId);
    expect(registryRows[0].checksum).toBe(expectedChecksum);
  });
});

// ── Book-detected worker registry lookup ──────────────────────────

describe("book-detected worker uses registry for ownership", () => {
  it("sets createdBy when registry entry exists for the checksum", async () => {
    // Create a temp file to simulate a detected book
    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const epubContent = "PK\x03\x04fake-epub-for-worker-test";
    const filePath = join(tempDir, "detected-book.epub");
    await writeFile(filePath, epubContent);

    // Pre-compute the checksum the worker will compute
    const { computeChecksumFromFile } = await import("../src/shared/checksum.js");
    const expectedChecksum = await computeChecksumFromFile(filePath);

    // Insert a registry entry as if the upload route created it
    await testDb.insert(uploadRegistry).values({
      checksum: expectedChecksum,
      userId: adminKeyId,
      filename: "detected-book.epub",
    });

    // Verify registry entry exists before worker runs
    const registryBefore = await testDb.select().from(uploadRegistry);
    expect(registryBefore).toHaveLength(1);

    // Create a mock parse queue
    const addedJobs: unknown[] = [];
    const mockParseQueue = {
      add: async (_name: string, data: unknown) => {
        addedJobs.push(data);
        return {};
      },
    };

    // Create the processor and run it
    const processor = createBookDetectedProcessor(mockParseQueue as never);
    const mockJob = {
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    };

    await processor(mockJob as never);

    // Verify a book was created with createdBy set
    const allBooks = await testDb.select().from(books);
    expect(allBooks).toHaveLength(1);
    expect(allBooks[0].createdBy).toBe(adminKeyId);
    expect(allBooks[0].status).toBe("inbox");

    // Verify book_files record was created with the correct checksum
    const allFiles = await testDb.select().from(bookFiles);
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0].checksum).toBe(expectedChecksum);
    expect(allFiles[0].bookId).toBe(allBooks[0].id);

    // Verify the registry entry was cleaned up
    const registryAfter = await testDb.select().from(uploadRegistry);
    expect(registryAfter).toHaveLength(0);

    // Verify parse job was enqueued
    expect(addedJobs).toHaveLength(1);
  });

  it("leaves createdBy null when no registry entry exists (filesystem drop)", async () => {
    // Simulate a book dropped into inbox via filesystem (no upload registry)
    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const filePath = join(tempDir, "filesystem-drop.epub");
    await writeFile(filePath, "PK\x03\x04filesystem-dropped-book");

    const addedJobs: unknown[] = [];
    const mockParseQueue = {
      add: async (_name: string, data: unknown) => {
        addedJobs.push(data);
        return {};
      },
    };

    const processor = createBookDetectedProcessor(mockParseQueue as never);
    const mockJob = {
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    };

    await processor(mockJob as never);

    // Book should exist but with null createdBy
    const allBooks = await testDb.select().from(books);
    expect(allBooks).toHaveLength(1);
    expect(allBooks[0].createdBy).toBeNull();

    // No registry entries should exist
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(0);

    // Parse job should still be enqueued
    expect(addedJobs).toHaveLength(1);
  });

  it("skips duplicate files and does not consume registry entry", async () => {
    // Create and process first file
    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const epubContent = "PK\x03\x04duplicate-test-epub";
    const filePath = join(tempDir, "duplicate.epub");
    await writeFile(filePath, epubContent);

    const mockParseQueue = {
      add: async () => ({}),
    };

    const processor = createBookDetectedProcessor(mockParseQueue as never);

    // First processing — should create the book
    await processor({
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    } as never);

    const booksAfterFirst = await testDb.select().from(books);
    expect(booksAfterFirst).toHaveLength(1);

    // Now insert a registry entry for the same checksum (simulating a re-upload)
    const { computeChecksumFromFile } = await import("../src/shared/checksum.js");
    const checksum = await computeChecksumFromFile(filePath);

    await testDb.insert(uploadRegistry).values({
      checksum,
      userId: adminKeyId,
      filename: "duplicate.epub",
    });

    // Second processing of same file — should skip (duplicate detection)
    await processor({
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    } as never);

    // Still only one book
    const booksAfterSecond = await testDb.select().from(books);
    expect(booksAfterSecond).toHaveLength(1);

    // Registry entry should NOT have been consumed (worker returned early)
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(1);
  });
});
