/**
 * Upload registry flow tests.
 *
 * Tests the upload registry mechanism that tracks book ownership:
 * 1. Upload route creates a registry row with correct userId + checksum
 * 2. Book-detected worker looks up registry by checksum and sets createdBy
 * 3. Registry entry is cleaned up after ownership is recorded
 */

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { bootstrapAdmin, createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import { seedAppPassword } from "../src/db/test-utils.js";
import { books, bookFiles, uploadRegistry } from "../src/db/schema.js";
import { computeChecksumFromBuffer } from "../src/shared/checksum.js";
import { createBookDetectedProcessor } from "../src/workers/book-detected.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let testApp: Awaited<ReturnType<typeof createTestApp>>;

// ── Per-test state ───────────────────────────────────────────────

let adminKey: string;
/**
 * The admin's USER id.
 *
 * The registry attributes an upload to a person, not to the credential it
 * arrived with — one user can hold several app passwords and every one of them
 * produces the same owner here.
 */
let adminUserId: string;

function validEpub(marker: string): Buffer {
  const name = Buffer.from("mimetype");
  const body = Buffer.from("application/epub+zip");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([header, name, body]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const comment = Buffer.from(marker);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([local, directory, eocd, comment]);
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
  // Files left in the inbox by an earlier test (or an earlier run) would be
  // collision-renamed by the next upload, which the duplicate cases assert on.
  await rm("/tmp/libris-test-inbox", { recursive: true, force: true });
  await mkdir("/tmp/libris-test-inbox", { recursive: true });

  // Bootstrapping the first admin and minting them a credential are two
  // separate acts; bootstrapAdmin does both.
  const admin = await bootstrapAdmin(testApp.services, $fetchRaw);
  adminUserId = admin.userId;
  adminKey = admin.rawKey;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

// ── Upload registry insert via API ────────────────────────────────

describe("upload route creates registry entry", () => {
  it("POST /api/inbox/upload inserts a registry row with correct checksum and userId", async () => {
    const epubContent = validEpub("test-book");
    const expectedChecksum = computeChecksumFromBuffer(epubContent);

    // Upload via multipart form
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(epubContent)], { type: "application/epub+zip" }),
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
    expect(registryRows[0].userId).toBe(adminUserId);
    expect(registryRows[0].filename).toBe("test-book.epub");
  });

  it("creates separate registry entries for multiple files in one upload", async () => {
    const content1 = validEpub("book-one");
    const content2 = validEpub("book-two");
    const checksum1 = computeChecksumFromBuffer(content1);
    const checksum2 = computeChecksumFromBuffer(content2);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(content1)], { type: "application/epub+zip" }),
      "book-one.epub",
    );
    formData.append(
      "file",
      new Blob([new Uint8Array(content2)], { type: "application/epub+zip" }),
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
      expect(row.userId).toBe(adminUserId);
    }
  });

  it("associates registry entry with the correct non-admin user", async () => {
    // seedAppPassword creates the person and issues them a credential — two
    // separate acts, both needed for a non-admin fixture.
    const { userId: regularUserId, rawKey: userKey } = await seedAppPassword(
      testApp.services.auth,
      testApp.testDb,
      { name: "regular-user", role: "user" },
    );

    const epubContent = validEpub("user-uploaded");
    const expectedChecksum = computeChecksumFromBuffer(epubContent);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(epubContent)], { type: "application/epub+zip" }),
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
    expect(registryRows[0].userId).toBe(regularUserId);
    expect(registryRows[0].userId).not.toBe(adminUserId);
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
      userId: adminUserId,
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
    const processor = createBookDetectedProcessor(mockParseQueue as never, tempDir);
    const mockJob = {
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    };

    await processor(mockJob as never);

    // Verify a book was created with createdBy set
    const allBooks = await testDb.select().from(books);
    expect(allBooks).toHaveLength(1);
    expect(allBooks[0].createdBy).toBe(adminUserId);
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

  it("gives an unattributed filesystem drop to the oldest admin", async () => {
    // books.created_by is NOT NULL, so there is no unowned state to fall back
    // to — the worker assigns the oldest admin. Oldest rather than any admin so
    // two files arriving at once cannot land on different owners.
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

    const processor = createBookDetectedProcessor(mockParseQueue as never, tempDir);
    const mockJob = {
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    };

    await processor(mockJob as never);

    const allBooks = await testDb.select().from(books);
    expect(allBooks).toHaveLength(1);
    expect(allBooks[0].createdBy).toBe(adminUserId);

    // No registry entries should exist
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(0);

    // Parse job should still be enqueued
    expect(addedJobs).toHaveLength(1);
  });

  it("refuses to ingest an unattributed file when no admin exists at all", async () => {
    // The flip side of NOT NULL: with nobody to own it, the worker must fail
    // loudly rather than invent an owner or write a half-row. This is the state
    // a fresh install is in before first-run setup, and the watcher can be
    // running by then.
    await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });

    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const filePath = join(tempDir, "no-admin.epub");
    await writeFile(filePath, "PK\x03\x04nobody-to-own-this");

    const processor = createBookDetectedProcessor({ add: async () => ({}) } as never, tempDir);

    await expect(
      processor({
        data: { filePath, detectedAt: new Date().toISOString() },
        log: async () => {},
      } as never),
    ).rejects.toThrow(/no admin exists/i);

    expect(await testDb.select().from(books)).toHaveLength(0);
  });

  it("skips a re-detected file without deleting the file the book was made from", async () => {
    // Re-detection of an already-ingested PATH — a watcher restart, say. No
    // second book, and the file the existing book_files row points at survives.
    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const epubContent = "PK\x03\x04duplicate-test-epub";
    const filePath = join(tempDir, "duplicate.epub");
    await writeFile(filePath, epubContent);

    const mockParseQueue = {
      add: async () => ({}),
    };

    const processor = createBookDetectedProcessor(mockParseQueue as never, tempDir);

    // First processing — should create the book
    await processor({
      data: { filePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    } as never);

    const booksAfterFirst = await testDb.select().from(books);
    expect(booksAfterFirst).toHaveLength(1);

    // A registry row for the same checksum AND the same file on disk, as a
    // re-upload of the identical path would leave behind.
    const { computeChecksumFromFile } = await import("../src/shared/checksum.js");
    const checksum = await computeChecksumFromFile(filePath);

    await testDb.insert(uploadRegistry).values({
      checksum,
      userId: adminUserId,
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

    // The stale row IS consumed now. It used to survive forever — the worker
    // returned early before touching upload_registry, so every deduped upload
    // left a row nothing would ever clean up. (This assertion is the inverse of
    // what this test pinned before; the old expectation encoded the bug.)
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(0);

    // ...but the file backing the existing book is untouched.
    await expect(access(filePath)).resolves.toBeUndefined();
  });

  it("attributes the book to the user whose file was actually ingested", async () => {
    // Two users upload identical bytes seconds apart, so the second file is
    // collision-renamed. Ownership must follow the file the watcher picks up,
    // not whichever registry row happens to be older.
    const { userId: bobUserId } = await seedAppPassword(testApp.services.auth, testApp.testDb, {
      name: "concurrent-bob",
      role: "user",
    });

    const tempDir = await mkdtemp(join(tmpdir(), "libris-worker-test-"));
    const contents = "PK\x03\x04concurrent-upload-epub";
    const alicePath = join(tempDir, "shared.epub");
    const bobPath = join(tempDir, "shared-1.epub");
    await writeFile(alicePath, contents);
    await writeFile(bobPath, contents);

    const { computeChecksumFromFile } = await import("../src/shared/checksum.js");
    const checksum = await computeChecksumFromFile(alicePath);

    // Alice (the admin here) registered first; Bob's row is newer.
    await testDb.insert(uploadRegistry).values({
      checksum,
      userId: adminUserId,
      filename: "shared.epub",
    });
    await testDb.insert(uploadRegistry).values({
      checksum,
      userId: bobUserId,
      filename: "shared-1.epub",
    });

    const processor = createBookDetectedProcessor({ add: async () => ({}) } as never, tempDir);

    // The watcher reaches BOB's file first.
    await processor({
      data: { filePath: bobPath, detectedAt: new Date().toISOString() },
      log: async () => {},
    } as never);

    const created = await testDb.select().from(books);
    expect(created).toHaveLength(1);
    // Pre-fix this was the admin: ownership came from the OLDEST registry row
    // regardless of which file was ingested.
    expect(created[0].createdBy).toBe(bobUserId);

    // Only Bob's row was consumed; Alice's still describes her un-ingested file.
    // Pre-fix every row for the checksum was deleted here, so her file had
    // nothing left to match against.
    const afterFirst = await testDb.select().from(uploadRegistry);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].userId).toBe(adminUserId);

    // The watcher then reaches Alice's copy, which is now a duplicate.
    await processor({
      data: { filePath: alicePath, detectedAt: new Date().toISOString() },
      log: async () => {},
    } as never);

    expect(await testDb.select().from(books)).toHaveLength(1);

    // No stale registry row and no orphaned file left behind.
    expect(await testDb.select().from(uploadRegistry)).toHaveLength(0);
    await expect(access(alicePath)).rejects.toThrow();
    // Bob's file, the one the book was made from, is still there.
    await expect(access(bobPath)).resolves.toBeUndefined();
  });
});

// ── Duplicate rejection at the upload route ───────────────────────

describe("upload route skips files already on the server", () => {
  function uploadEpub(rawKey: string, content: Buffer, filename: string) {
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(content)], { type: "application/epub+zip" }),
      filename,
    );
    return testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}` },
      body: formData,
    });
  }

  it("tells a second uploader instead of accepting bytes that will never surface", async () => {
    const { rawKey: bobKey } = await seedAppPassword(testApp.services.auth, testApp.testDb, {
      name: "duplicate-bob",
      role: "user",
    });

    const epubContent = validEpub("shared-between-users");
    const checksum = computeChecksumFromBuffer(epubContent);

    // Alice uploads first and is accepted.
    expect((await uploadEpub(adminKey, epubContent, "shared.epub")).status).toBe(200);

    // Bob uploads the same bytes. Nothing is written and nothing failed: the
    // library already holds this book, which is what Bob was after. That is a
    // 200 whose body reports the file under `skipped`, never `errors`.
    const bobResponse = await uploadEpub(bobKey, epubContent, "shared.epub");
    expect(bobResponse.status).toBe(200);
    const bobBody = await bobResponse.json();
    expect(bobBody.uploaded).toEqual([]);
    expect(bobBody.errors).toEqual([]);
    expect(bobBody.skipped).toEqual([
      { filename: "shared.epub", reason: "This file has already been uploaded to this library" },
    ]);

    // Only Alice's registry row exists, and Bob's copy was never written.
    const registryRows = await testDb.select().from(uploadRegistry);
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0].checksum).toBe(checksum);
    expect(registryRows[0].userId).toBe(adminUserId);
    await expect(access("/tmp/libris-test-inbox/shared-1.epub")).rejects.toThrow();
  });

  it("puts the duplicate in skipped and not errors when a batch also contains a new file", async () => {
    const duplicate = validEpub("batch-duplicate");
    const fresh = validEpub("batch-fresh");

    expect((await uploadEpub(adminKey, duplicate, "batch-dup.epub")).status).toBe(200);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(duplicate)], { type: "application/epub+zip" }),
      "batch-dup.epub",
    );
    formData.append(
      "file",
      new Blob([new Uint8Array(fresh)], { type: "application/epub+zip" }),
      "batch-fresh.epub",
    );

    const response = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: formData,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.uploaded).toEqual([expect.objectContaining({ filename: "batch-fresh.epub" })]);
    // The whole point of the split: a caller can now say "1 uploaded, 1 already
    // in your library" instead of "1 uploaded, 1 failed".
    expect(body.skipped).toEqual([
      expect.objectContaining({
        filename: "batch-dup.epub",
        reason: expect.stringContaining("already been uploaded"),
      }),
    ]);
    expect(body.errors).toEqual([]);

    // The new file really was written and registered, so the skip did not cost
    // the rest of the batch anything.
    await access("/tmp/libris-test-inbox/batch-fresh.epub");
    const checksums = (await testDb.select().from(uploadRegistry)).map((r) => r.checksum);
    expect(checksums).toContain(computeChecksumFromBuffer(fresh));
  });

  it("keeps a genuine rejection in errors while a duplicate goes to skipped", async () => {
    const duplicate = validEpub("mixed-duplicate");
    expect((await uploadEpub(adminKey, duplicate, "mixed-dup.epub")).status).toBe(200);

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([new Uint8Array(duplicate)], { type: "application/epub+zip" }),
      "mixed-dup.epub",
    );
    formData.append("file", new Blob([new Uint8Array(Buffer.from("not a zip"))]), "broken.epub");

    const response = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: formData,
    });

    // Nothing was written, but the batch was not entirely a failure — one file
    // is already in the library. 400 is reserved for batches that only failed.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.uploaded).toEqual([]);
    expect(body.skipped).toEqual([expect.objectContaining({ filename: "mixed-dup.epub" })]);
    expect(body.errors).toEqual([expect.objectContaining({ filename: "broken.epub" })]);
  });

  it("still answers 400 when every file failed for a real reason", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(Buffer.from("not a zip"))]), "junk.epub");

    const response = await testApp.app.request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}` },
      body: formData,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("All files rejected");
  });
});
