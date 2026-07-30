import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import { and, eq } from "drizzle-orm";
import { books, readingProgress } from "../src/db/schema.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;

// ── Per-test state ───────────────────────────────────────────────

/** Admin API key (first key created via /setup, always isAdmin=true) */
let adminKey: string;
let adminKeyId: string;

/** Non-admin API key (created by admin via POST /api/auth/keys) */
let userKey: string;
let userKeyId: string;

function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

function userAuth() {
  return { authorization: `Bearer ${userKey}` };
}

// ── App lifecycle: create once ─────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
});

// ── Per-test lifecycle ─────────────────────────────────────────────

beforeEach(async () => {
  // Wipe all tables + caches
  await $fetchRaw("/__test/cleanup", { method: "POST" });

  // Create admin key (first key is always admin)
  const { data: setupData, status: setupStatus } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "admin-key" },
  });
  expect(setupStatus).toBe(201);
  adminKey = setupData.key;
  adminKeyId = setupData.id;

  // Admin creates a non-admin key
  const { data: userKeyData, status: userKeyStatus } = await $fetchRaw("/api/auth/keys", {
    method: "POST",
    body: { label: "user-key" },
    headers: adminAuth(),
  });
  expect(userKeyStatus).toBe(201);
  userKey = userKeyData.key;
  userKeyId = userKeyData.id;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

// ═══════════════════════════════════════════════════════════════════
// 1. Admin vs non-admin access control
// ═══════════════════════════════════════════════════════════════════

describe("admin vs non-admin access control", () => {
  it("non-admin gets 403 on POST /api/auth/keys (create key)", async () => {
    const { status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "attempted-key" },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on DELETE /api/auth/keys/:id", async () => {
    const { status } = await $fetchRaw(`/api/auth/keys/${adminKeyId}`, {
      method: "DELETE",
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on PATCH /api/settings", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on admin-only job management routes", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("admin can access POST /api/auth/keys", async () => {
    const { status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "third-key" },
      headers: adminAuth(),
    });
    expect(status).toBe(201);
  });

  it("admin can access PATCH /api/settings", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("admin can access job management routes", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("non-admin can list keys but only sees their own", async () => {
    const { data, status } = await $fetchRaw("/api/auth/keys", {
      headers: userAuth(),
    });
    expect(status).toBe(200);
    expect(data.keys).toHaveLength(1);
    expect(data.keys[0].id).toBe(userKeyId);
  });

  it("admin can list all keys", async () => {
    const { data, status } = await $fetchRaw("/api/auth/keys", {
      headers: adminAuth(),
    });
    expect(status).toBe(200);
    expect(data.keys.length).toBeGreaterThanOrEqual(2);
    const ids = data.keys.map((k: { id: string }) => k.id);
    expect(ids).toContain(adminKeyId);
    expect(ids).toContain(userKeyId);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Book ownership (requireBookOwnership)
// ═══════════════════════════════════════════════════════════════════

describe("book ownership (requireBookOwnership)", () => {
  let adminBookId: string;
  let userBookId: string;
  let unownedBookId: string;

  beforeEach(async () => {
    // Insert a book owned by admin
    const [adminBook] = await testDb
      .insert(books)
      .values({
        title: "Admin Book",
        author: "Admin Author",
        status: "review",
        createdBy: adminKeyId,
      })
      .returning({ id: books.id });
    adminBookId = adminBook!.id;

    // Insert a book owned by user
    const [userBook] = await testDb
      .insert(books)
      .values({
        title: "User Book",
        author: "User Author",
        status: "review",
        createdBy: userKeyId,
      })
      .returning({ id: books.id });
    userBookId = userBook!.id;

    // Insert an unowned book (createdBy = null)
    const [unownedBook] = await testDb
      .insert(books)
      .values({
        title: "Unowned Book",
        author: "Unknown",
        status: "review",
        createdBy: null,
      })
      .returning({ id: books.id });
    unownedBookId = unownedBook!.id;
  });

  it("admin can delete any book (even ones they did not create)", async () => {
    const { status } = await $fetchRaw(`/api/books/${userBookId}`, {
      method: "DELETE",
      headers: adminAuth(),
      responseType: "text",
    });
    expect(status).toBe(204);
  });

  it("owner can delete their own book", async () => {
    const { status } = await $fetchRaw(`/api/books/${userBookId}`, {
      method: "DELETE",
      headers: userAuth(),
      responseType: "text",
    });
    expect(status).toBe(204);
  });

  it("non-owner non-admin gets 403 when deleting another user's book", async () => {
    const { status } = await $fetchRaw(`/api/books/${adminBookId}`, {
      method: "DELETE",
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("unowned books (createdBy=null) are admin-only", async () => {
    // Non-admin should get 403
    const { status: userStatus } = await $fetchRaw(`/api/books/${unownedBookId}`, {
      method: "DELETE",
      headers: userAuth(),
    });
    expect(userStatus).toBe(403);

    // Admin should succeed
    const { status: adminStatus } = await $fetchRaw(`/api/books/${unownedBookId}`, {
      method: "DELETE",
      headers: adminAuth(),
      responseType: "text",
    });
    expect(adminStatus).toBe(204);
  });

  it("admin can approve any book", async () => {
    const { status } = await $fetchRaw(`/api/books/${userBookId}/approve`, {
      method: "POST",
      body: {
        fields: {
          title: { value: "Updated Title", source: "manual" },
        },
      },
      headers: adminAuth(),
    });
    expect(status).toBe(200);
  });

  it("owner can approve their own book", async () => {
    const { status } = await $fetchRaw(`/api/books/${userBookId}/approve`, {
      method: "POST",
      body: {
        fields: {
          title: { value: "User Updated", source: "manual" },
        },
      },
      headers: userAuth(),
    });
    expect(status).toBe(200);
  });

  it("non-owner non-admin gets 403 when approving another user's book", async () => {
    const { status } = await $fetchRaw(`/api/books/${adminBookId}/approve`, {
      method: "POST",
      body: {
        fields: {
          title: { value: "Hijacked", source: "manual" },
        },
      },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("returns 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/books/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: adminAuth(),
      responseType: "text",
    });
    expect(status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. API key management
// ═══════════════════════════════════════════════════════════════════

describe("API key management", () => {
  it("admin creates key with 201", async () => {
    const { data, status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "new-user" },
      headers: adminAuth(),
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      key: expect.any(String),
      label: "new-user",
    });
  });

  it("non-admin cannot create key (403)", async () => {
    const { status } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "sneaky-key" },
      headers: userAuth(),
    });
    expect(status).toBe(403);
  });

  it("cannot delete the last remaining API key", async () => {
    // Delete the user key first (so only admin key remains)
    const { status: deleteUserStatus } = await $fetchRaw(`/api/auth/keys/${userKeyId}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(deleteUserStatus).toBe(200);

    // Now try to delete admin key (it's the last one and also the active key)
    const { status } = await $fetchRaw(`/api/auth/keys/${adminKeyId}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    // Should be 409: either "last key" or "active key" protection
    expect(status).toBe(409);
  });

  it("deleted key returns 401 on next request", async () => {
    // Create a third key so we have 3 total
    const { data: thirdKeyData } = await $fetchRaw("/api/auth/keys", {
      method: "POST",
      body: { label: "third-key" },
      headers: adminAuth(),
    });
    const thirdKey = thirdKeyData.key;
    const thirdKeyId = thirdKeyData.id;

    // Verify the third key works
    const { status: beforeStatus } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Bearer ${thirdKey}` },
    });
    expect(beforeStatus).toBe(200);

    // Admin deletes the third key
    const { status: deleteStatus } = await $fetchRaw(`/api/auth/keys/${thirdKeyId}`, {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(deleteStatus).toBe(200);

    // The deleted key should now return 401
    const { status: afterStatus } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Bearer ${thirdKey}` },
    });
    expect(afterStatus).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Credential isolation
// ═══════════════════════════════════════════════════════════════════

describe("credential isolation", () => {
  it("user A sets OPDS credentials, user B cannot see them", async () => {
    // Admin sets OPDS credentials
    const { status: putStatus } = await $fetchRaw("/api/credentials/opds", {
      method: "PUT",
      body: { username: "admin-opds", password: "admin-pass" },
      headers: adminAuth(),
    });
    expect(putStatus).toBe(200);

    // Admin can see their own credentials
    const { data: adminCreds, status: adminGetStatus } = await $fetchRaw("/api/credentials/opds", {
      headers: adminAuth(),
    });
    expect(adminGetStatus).toBe(200);
    expect(adminCreds.configured).toBe(true);
    expect(adminCreds.username).toBe("admin-opds");

    // Non-admin user cannot see admin's credentials
    const { data: userCreds, status: userGetStatus } = await $fetchRaw("/api/credentials/opds", {
      headers: userAuth(),
    });
    expect(userGetStatus).toBe(200);
    expect(userCreds.configured).toBe(false);
  });

  it("user A and user B have independent credentials", async () => {
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

    // Each user sees only their own
    const { data: adminCreds } = await $fetchRaw("/api/credentials/opds", {
      headers: adminAuth(),
    });
    expect(adminCreds.configured).toBe(true);
    expect(adminCreds.username).toBe("admin-opds");

    const { data: userCreds } = await $fetchRaw("/api/credentials/opds", {
      headers: userAuth(),
    });
    expect(userCreds.configured).toBe(true);
    expect(userCreds.username).toBe("user-opds");
  });

  it("deleting user A credentials does not affect user B", async () => {
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

    // Admin deletes their own kosync credentials
    const { status: deleteStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "DELETE",
      headers: adminAuth(),
    });
    expect(deleteStatus).toBe(200);

    // Admin's credentials are gone
    const { data: adminCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminAuth(),
    });
    expect(adminCreds.configured).toBe(false);

    // User's credentials are still intact
    const { data: userCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: userAuth(),
    });
    expect(userCreds.configured).toBe(true);
    expect(userCreds.username).toBe("user-kosync");
  });

  it("user cannot delete credentials they don't own (returns 404)", async () => {
    // Admin sets Hardcover credentials
    await $fetchRaw("/api/credentials/hardcover", {
      method: "PUT",
      body: { username: "admin-hc", password: "admin-token" },
      headers: adminAuth(),
    });

    // User tries to delete (they have no hardcover credentials)
    const { status } = await $fetchRaw("/api/credentials/hardcover", {
      method: "DELETE",
      headers: userAuth(),
    });
    expect(status).toBe(404);

    // Admin's credentials are still there
    const { data: adminCreds } = await $fetchRaw("/api/credentials/hardcover", {
      headers: adminAuth(),
    });
    expect(adminCreds.configured).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Reading progress isolation
// ═══════════════════════════════════════════════════════════════════
//
// Note: /api/stats and /api/reading-status/counts use raw SQL that
// returns differently under PGlite vs PostgreSQL (db.execute shape).
// We test isolation at the DB layer and via the unique constraint
// to verify the schema correctly partitions progress by apiKeyId.

describe("reading progress isolation", () => {
  let bookId: string;

  beforeEach(async () => {
    // Create a shared book
    const [book] = await testDb
      .insert(books)
      .values({
        title: "Shared Book",
        author: "Test Author",
        status: "organized",
        pageCount: 300,
        genres: ["fiction"],
        createdBy: adminKeyId,
      })
      .returning({ id: books.id });
    bookId = book!.id;
  });

  it("two users can have independent reading progress on the same book", async () => {
    // Insert reading progress for admin (80%)
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: adminKeyId,
      document: "shared-book.epub",
      device: "admin-device",
      progress: "/body/chapter[8]",
      percentage: "0.8000",
      timestamp: BigInt(Date.now()),
    });

    // Insert reading progress for user (30%) - same document, different device/user
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: userKeyId,
      document: "shared-book.epub",
      device: "user-device",
      progress: "/body/chapter[3]",
      percentage: "0.3000",
      timestamp: BigInt(Date.now()),
    });

    // Query admin's progress
    const adminRows = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.apiKeyId, adminKeyId)));
    expect(adminRows).toHaveLength(1);
    expect(Number(adminRows[0]!.percentage)).toBeCloseTo(0.8, 2);

    // Query user's progress
    const userRows = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.apiKeyId, userKeyId)));
    expect(userRows).toHaveLength(1);
    expect(Number(userRows[0]!.percentage)).toBeCloseTo(0.3, 2);
  });

  it("per-user unique constraint allows same document+device for different users", async () => {
    // Both users reading the same document on same-named device
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: adminKeyId,
      document: "shared-book.epub",
      device: "shared-device",
      progress: "/body/chapter[8]",
      percentage: "0.8000",
      timestamp: BigInt(Date.now()),
    });

    // Should NOT violate unique constraint because apiKeyId is different
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: userKeyId,
      document: "shared-book.epub",
      device: "shared-device",
      progress: "/body/chapter[3]",
      percentage: "0.3000",
      timestamp: BigInt(Date.now()),
    });

    // Both rows exist
    const allRows = await testDb
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.bookId, bookId));
    expect(allRows).toHaveLength(2);
  });

  it("user A progress update does not overwrite user B progress", async () => {
    // Insert initial progress for both users
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: adminKeyId,
      document: "shared-book.epub",
      device: "admin-device",
      progress: "/body/chapter[5]",
      percentage: "0.5000",
      timestamp: BigInt(Date.now()),
    });
    await testDb.insert(readingProgress).values({
      bookId,
      apiKeyId: userKeyId,
      document: "shared-book.epub",
      device: "user-device",
      progress: "/body/chapter[2]",
      percentage: "0.2000",
      timestamp: BigInt(Date.now()),
    });

    // Admin updates their progress to 99%
    await testDb
      .update(readingProgress)
      .set({ percentage: "0.9900", progress: "/body/chapter[10]" })
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.apiKeyId, adminKeyId)));

    // User's progress should be unchanged
    const [userRow] = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.apiKeyId, userKeyId)));
    expect(Number(userRow!.percentage)).toBeCloseTo(0.2, 2);

    // Admin's progress should be updated
    const [adminRow] = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.apiKeyId, adminKeyId)));
    expect(Number(adminRow!.percentage)).toBeCloseTo(0.99, 2);
  });
});
