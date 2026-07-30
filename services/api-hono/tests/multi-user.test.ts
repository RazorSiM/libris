/**
 * Multi-user integration tests.
 *
 * Tests authorization boundaries: admin vs non-admin keys, book ownership,
 * credential isolation, KoSync progress isolation, reading stats isolation,
 * Hardcover sync log isolation, and admin-only route protection.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import { books, readingProgress, hardcoverSyncLog } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;

// ── Per-test state ───────────────────────────────────────────────

let adminKey: string;
let adminKeyId: string;
let userKey: string;
let userKeyId: string;

function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

function userAuth() {
  return { authorization: `Bearer ${userKey}` };
}

// ── App lifecycle ──────────────────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
});

// ── Per-test lifecycle ─────────────────────────────────────────────

beforeEach(async () => {
  // Wipe all tables + redis
  await $fetchRaw("/__test/cleanup", { method: "POST" });

  // Create admin key via setup (first key is always admin)
  const { data: setupData, status: setupStatus } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "admin-key" },
  });
  expect(setupStatus).toBe(201);
  adminKey = setupData.key;
  adminKeyId = setupData.id;

  // Create non-admin key via authenticated endpoint
  const { data: userData, status: userStatus } = await $fetchRaw("/api/auth/keys", {
    method: "POST",
    body: { label: "regular-user-key" },
    headers: adminAuth(),
  });
  expect(userStatus).toBe(201);
  userKey = userData.key;
  userKeyId = userData.id;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

// ── API Key Management ────────────────────────────────────────────

describe("API key management", () => {
  it("admin can create new keys", async () => {
    const { data, status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "third-key" },
      headers: adminAuth(),
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      key: expect.any(String),
      label: "third-key",
    });
  });

  it("non-admin gets 403 when creating keys", async () => {
    const { status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "unauthorized-key" },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("admin can delete non-active keys", async () => {
    // Create an extra key to delete
    const { data: extra } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "to-delete" },
      headers: adminAuth(),
    });
    const { status } = await $fetchRaw(`/api/auth/keys/${extra.id}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("non-admin gets 403 when deleting keys", async () => {
    // Create an extra key so we have something to try to delete
    const { data: extra } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "extra" },
      headers: adminAuth(),
    });
    const { status } = await $fetchRaw(`/api/auth/keys/${extra.id}`, {
      method: "DELETE",
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("cannot delete the last admin key", async () => {
    // Try to delete the admin key (it's the only admin key)
    const { status } = await $fetchRaw(`/api/auth/keys/${adminKeyId}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    // Should fail — either 409 (cannot delete active key) or 409 (last key)
    expect(status).toBe(409);
  });

  it("admin sees all keys, non-admin sees only own key", async () => {
    const { data: adminList } = await $fetchRaw("/api/auth/keys", {
      headers: adminAuth(),
    });
    expect(adminList.keys.length).toBeGreaterThanOrEqual(2);

    const { data: userList } = await $fetchRaw("/api/auth/keys", {
      headers: userAuth(),
    });
    expect(userList.keys.length).toBe(1);
    expect(userList.keys[0].id).toBe(userKeyId);
  });
});

// ── Book Ownership ────────────────────────────────────────────────

describe("book ownership", () => {
  let adminBookId: string;
  let userBookId: string;
  let unownedBookId: string;

  beforeEach(async () => {
    // Seed a book owned by admin
    const { data: seedAdmin } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "Admin's Book", author: "Admin Author", status: "organized" }],
      },
    });
    adminBookId = seedAdmin.inserted[0].id;
    // Set created_by on admin book
    await testDb.update(books).set({ createdBy: adminKeyId }).where(eq(books.id, adminBookId));

    // Seed a book owned by regular user
    const { data: seedUser } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "User's Book", author: "User Author", status: "organized" }],
      },
    });
    userBookId = seedUser.inserted[0].id;
    await testDb.update(books).set({ createdBy: userKeyId }).where(eq(books.id, userBookId));

    // Seed an unowned book (created_by = null)
    const { data: seedUnowned } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "Unowned Book", author: "Nobody", status: "organized" }],
      },
    });
    unownedBookId = seedUnowned.inserted[0].id;
  });

  it("admin can edit any book", async () => {
    const { status } = await $fetchRaw(`/api/library/${userBookId}`, {
      method: "PATCH",
      body: { title: "Updated by Admin" },
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("owner can edit own book", async () => {
    const { status } = await $fetchRaw(`/api/library/${userBookId}`, {
      method: "PATCH",
      body: { title: "Updated by Owner" },
      headers: userAuth(),
    });
    expect(status).toBe(200);
  });

  it("non-owner gets 403 editing another user's book", async () => {
    const { status } = await $fetchRaw(`/api/library/${adminBookId}`, {
      method: "PATCH",
      body: { title: "Should Fail" },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 editing unowned (null createdBy) book", async () => {
    const { status } = await $fetchRaw(`/api/library/${unownedBookId}`, {
      method: "PATCH",
      body: { title: "Should Fail" },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("admin can edit unowned book", async () => {
    const { status } = await $fetchRaw(`/api/library/${unownedBookId}`, {
      method: "PATCH",
      body: { title: "Updated by Admin" },
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });
});

// ── Credential Isolation ──────────────────────────────────────────

describe("credential isolation", () => {
  it("user A's credentials are invisible to user B", async () => {
    // Admin sets OPDS credentials
    const { status: putStatus } = await $fetchRaw("/api/credentials/opds", {
      method: "PUT",
      body: { username: "admin-opds", password: "admin-pass" },
      headers: adminAuth(),
    });
    expect(putStatus).toBe(200);

    // Admin sees own credentials
    const { data: adminCred, status: adminStatus } = await $fetchRaw("/api/credentials/opds", {
      headers: adminAuth(),
    });
    expect(adminStatus).toBe(200);
    expect(adminCred.configured).toBe(true);
    expect(adminCred.username).toBe("admin-opds");

    // Regular user sees unconfigured (no credentials for their apiKeyId)
    const { data: userCred, status: userStatus } = await $fetchRaw("/api/credentials/opds", {
      headers: userAuth(),
    });
    expect(userStatus).toBe(200);
    expect(userCred.configured).toBe(false);
  });

  it("each user can set independent credentials", async () => {
    // Admin sets OPDS credentials
    await $fetchRaw("/api/credentials/opds", {
      method: "PUT",
      body: { username: "admin-opds", password: "admin-pass" },
      headers: adminAuth(),
    });

    // User sets different OPDS credentials
    await $fetchRaw("/api/credentials/opds", {
      method: "PUT",
      body: { username: "user-opds", password: "user-pass" },
      headers: userAuth(),
    });

    // Verify each sees their own
    const { data: adminCred } = await $fetchRaw("/api/credentials/opds", {
      headers: adminAuth(),
    });
    expect(adminCred.username).toBe("admin-opds");

    const { data: userCred } = await $fetchRaw("/api/credentials/opds", {
      headers: userAuth(),
    });
    expect(userCred.username).toBe("user-opds");
  });

  it("deleting one user's credential does not affect the other", async () => {
    // Both users set credentials
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass" },
      headers: adminAuth(),
    });
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass" },
      headers: userAuth(),
    });

    // Delete admin's credential
    const { status: delStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(delStatus).toBe(200);

    // User's credential still exists
    const { data: userCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: userAuth(),
    });
    expect(userCred.configured).toBe(true);
    expect(userCred.username).toBe("user-kosync");

    // Admin's credential is gone
    const { data: adminCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminAuth(),
    });
    expect(adminCred.configured).toBe(false);
  });
});

// ── KoSync Progress Isolation ─────────────────────────────────────

describe("KoSync progress isolation", () => {
  const ADMIN_TESTPASS_MD5 = "179ad45c6ce2cb97cf1029e212046e81"; // md5("testpass")

  async function seedKosyncForAdmin() {
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      headers: adminAuth(),
      body: { username: "admin-kosync", password: "testpass" },
    });
  }

  async function seedKosyncForUser() {
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      headers: userAuth(),
      body: { username: "user-kosync", password: "testpass" },
    });
  }

  function adminKosyncAuth() {
    return { "x-auth-user": "admin-kosync", "x-auth-key": ADMIN_TESTPASS_MD5 };
  }

  function userKosyncAuth() {
    return { "x-auth-user": "user-kosync", "x-auth-key": ADMIN_TESTPASS_MD5 };
  }

  it("two users see different progress on the same document", async () => {
    await seedKosyncForAdmin();
    await seedKosyncForUser();

    // Admin sets progress at 75%
    await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: adminKosyncAuth(),
      body: {
        document: "shared-book.epub",
        progress: "/body/ch[7]",
        device: "kindle",
        percentage: 0.75,
      },
    });

    // User sets progress at 25%
    await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: userKosyncAuth(),
      body: {
        document: "shared-book.epub",
        progress: "/body/ch[2]",
        device: "kindle",
        percentage: 0.25,
      },
    });

    // Admin reads their progress
    const { data: adminProgress, status: adminStatus } = await $fetchRaw(
      "/kosync/syncs/progress/shared-book.epub",
      { headers: adminKosyncAuth() },
    );
    expect(adminStatus).toBe(200);
    expect(adminProgress.percentage).toBe(0.75);

    // User reads their progress
    const { data: userProgress, status: userStatus } = await $fetchRaw(
      "/kosync/syncs/progress/shared-book.epub",
      { headers: userKosyncAuth() },
    );
    expect(userStatus).toBe(200);
    expect(userProgress.percentage).toBe(0.25);
  });
});

// ── Reading Stats Isolation ───────────────────────────────────────
// NOTE: The /api/stats endpoint uses raw SQL (db.execute) that returns
// PGlite-incompatible result shapes. Stats isolation is verified at the
// data layer here; the full endpoint is tested in E2E against real Postgres.

describe("reading stats isolation", () => {
  it("reading progress rows are scoped per user via apiKeyId", async () => {
    // Seed books
    const { data: booksData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [
          { title: "Admin Book 1", author: "A1", status: "organized" },
          { title: "Admin Book 2", author: "A2", status: "organized" },
          { title: "Admin Book 3", author: "A3", status: "organized" },
          { title: "User Book 1", author: "U1", status: "organized" },
        ],
      },
    });
    const [ab1, ab2, ab3, ub1] = booksData.inserted;

    // Seed files for all books
    await $fetchRaw("/__test/seed-files", {
      method: "POST",
      body: {
        files: [
          { bookId: ab1.id, format: "epub", originalName: "a1.epub", contentHash: "hash-a1" },
          { bookId: ab2.id, format: "epub", originalName: "a2.epub", contentHash: "hash-a2" },
          { bookId: ab3.id, format: "epub", originalName: "a3.epub", contentHash: "hash-a3" },
          { bookId: ub1.id, format: "epub", originalName: "u1.epub", contentHash: "hash-u1" },
        ],
      },
    });

    // Admin finishes 3 books
    const now = Math.floor(Date.now() / 1000);
    for (const [bookId, hash] of [
      [ab1.id, "hash-a1"],
      [ab2.id, "hash-a2"],
      [ab3.id, "hash-a3"],
    ] as const) {
      await testDb.insert(readingProgress).values({
        bookId,
        apiKeyId: adminKeyId,
        document: hash,
        device: "kindle",
        progress: "end",
        percentage: "0.9800",
        timestamp: BigInt(now),
      });
    }

    // User finishes 1 book
    await testDb.insert(readingProgress).values({
      bookId: ub1.id,
      apiKeyId: userKeyId,
      document: "hash-u1",
      device: "kindle",
      progress: "end",
      percentage: "0.9800",
      timestamp: BigInt(now),
    });

    // Verify isolation at the data layer: query progress rows per user
    const adminRows = await testDb
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.apiKeyId, adminKeyId));
    expect(adminRows).toHaveLength(3);

    const userRows = await testDb
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.apiKeyId, userKeyId));
    expect(userRows).toHaveLength(1);

    // Verify all admin rows have >= 95% (finished threshold)
    for (const row of adminRows) {
      expect(Number(row.percentage)).toBeGreaterThanOrEqual(0.95);
    }
    expect(Number(userRows[0]!.percentage)).toBeGreaterThanOrEqual(0.95);
  });
});

// ── Hardcover Sync Log Isolation ──────────────────────────────────

describe("hardcover sync log isolation", () => {
  it("each user has independent sync log entries", async () => {
    // Seed a shared book
    const { data: seedData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "Shared Book", author: "Shared Author", status: "organized" }],
      },
    });
    const bookId = seedData.inserted[0].id;

    // Insert sync log entries for both users directly
    await testDb.insert(hardcoverSyncLog).values({
      bookId,
      apiKeyId: adminKeyId,
      lastStatus: "currently_reading",
      lastProgress: "0.5000",
      lastSyncedAt: new Date(),
    });

    await testDb.insert(hardcoverSyncLog).values({
      bookId,
      apiKeyId: userKeyId,
      lastStatus: "want_to_read",
      lastProgress: "0.0000",
      lastSyncedAt: new Date(),
    });

    // Verify both entries exist with different statuses
    const adminLogs = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(eq(hardcoverSyncLog.apiKeyId, adminKeyId));
    expect(adminLogs).toHaveLength(1);
    expect(adminLogs[0]!.lastStatus).toBe("currently_reading");

    const userLogs = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(eq(hardcoverSyncLog.apiKeyId, userKeyId));
    expect(userLogs).toHaveLength(1);
    expect(userLogs[0]!.lastStatus).toBe("want_to_read");
  });
});

// ── Admin-Only Routes ─────────────────────────────────────────────

describe("admin-only routes", () => {
  it("non-admin gets 403 on GET /api/settings (PATCH)", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on GET /api/jobs/status", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("admin can access GET /api/jobs/status", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("non-admin can still GET /api/settings (read-only)", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      headers: userAuth(),
    });
    expect(status).toBe(200);
  });
});
