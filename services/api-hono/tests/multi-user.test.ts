/**
 * Multi-user integration tests.
 *
 * Authorization boundaries between two people: book ownership, credential
 * isolation, KoSync progress isolation, reading stats isolation, Hardcover sync
 * log isolation, and admin-only route protection.
 *
 * Two kinds of credential appear below, and which one a test uses is load-
 * bearing:
 *   • app password (Bearer) — the library surface, and what an e-reader holds.
 *   • session cookie — admin routes, /api/auth/* and credential management,
 *     which refuse app passwords outright. A role test MUST use a session, or
 *     it would pass without any role check existing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { bootstrapAdmin, createAccount, createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { AppServices } from "../src/bootstrap.js";
import { books, readingProgress, hardcoverSyncLog } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: AppServices;

// ── Per-test state ───────────────────────────────────────────────

let adminKey: string;
let adminUserId: string;
let adminCookie: string;
let userKey: string;
let userUserId: string;
let userCookie: string;

/** An app password: the library surface, and what an e-reader holds. */
function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

function userAuth() {
  return { authorization: `Bearer ${userKey}` };
}

/** A browser session: everything app passwords are scoped out of. */
function adminSession() {
  return { cookie: adminCookie };
}

function userSession() {
  return { cookie: userCookie };
}

// ── App lifecycle ──────────────────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
});

// ── Per-test lifecycle ─────────────────────────────────────────────

beforeEach(async () => {
  // includeAuth so every test starts from an empty install. These suites assert
  // on how many credentials a person holds, which only means something if the
  // previous test's fixtures are gone.
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });

  const admin = await bootstrapAdmin(services, $fetchRaw);
  adminUserId = admin.userId;
  adminKey = admin.rawKey;
  adminCookie = admin.cookie;

  const member = await createAccount(services, { email: "member@example.test", role: "user" });
  userUserId = member.userId;
  userKey = member.rawKey;
  userCookie = member.cookie;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });
});

// ── App password management ───────────────────────────────────────

/**
 * A credential is something you hold, so everyone manages their own and nobody
 * — admin included — manages anyone else's. Creating an ACCOUNT is a separate
 * and genuinely admin act.
 */
describe("app password management", () => {
  it("a non-admin can mint their own", async () => {
    const { data, status } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "their-own-kobo" },
      headers: userSession(),
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      key: expect.any(String),
      name: "their-own-kobo",
    });

    // And it works: the credential a regular user issues themselves reaches the
    // library, which is the whole point of them being allowed to issue it.
    const { status: used } = await $fetchRaw("/api/library", {
      headers: { authorization: `Bearer ${data.key}` },
    });
    expect(used).toBe(200);
  });

  it("everyone sees only their own, admin included", async () => {
    // An admin is not a superuser over other people's credentials. They manage
    // the accounts that hold them, not the credentials themselves.
    await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "admin-extra" },
      headers: adminSession(),
    });

    const { data: adminList } = await $fetchRaw("/api/app-passwords", {
      headers: adminSession(),
    });
    const { data: userList } = await $fetchRaw("/api/app-passwords", {
      headers: userSession(),
    });

    expect(adminList.keys.every((k: { name: string }) => k.name !== "member-key")).toBe(true);
    expect(userList.keys).toHaveLength(1);
    expect(userList.keys[0].name).toBe("member-key");
  });

  it("revoking your own works", async () => {
    const { data: extra } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "to-revoke" },
      headers: userSession(),
    });
    const { status } = await $fetchRaw(`/api/app-passwords/${extra.id}`, {
      method: "DELETE",
      headers: userSession(),
    });
    expect(status).toBe(204);
  });

  it("revoking someone else's is a 404, not a 403", async () => {
    // Deliberate: 403 would confirm the id exists, which is what an attacker
    // enumerating ids wants to learn. Note this holds for the ADMIN trying to
    // revoke a member's credential too.
    const { data: theirs } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "not-yours" },
      headers: userSession(),
    });
    const { status } = await $fetchRaw(`/api/app-passwords/${theirs.id}`, {
      method: "DELETE",
      headers: adminSession(),
    });
    expect(status).toBe(404);
  });

  it("nothing stops you revoking the credential you are holding", async () => {
    // Revoking the credential you are authenticating with costs you that
    // credential and nothing else — the session doing the revoking is a
    // separate thing and survives.
    const { data: list } = await $fetchRaw("/api/app-passwords", { headers: userSession() });
    const { status } = await $fetchRaw(`/api/app-passwords/${list.keys[0].id}`, {
      method: "DELETE",
      headers: userSession(),
    });
    expect(status).toBe(204);

    // The credential is dead...
    const { status: withKey } = await $fetchRaw("/api/library", { headers: userAuth() });
    expect(withKey).toBe(401);
    // ...and the person is not.
    const { status: withSession } = await $fetchRaw("/api/library", { headers: userSession() });
    expect(withSession).toBe(200);
  });
});

// ── Book Ownership ────────────────────────────────────────────────

describe("book ownership", () => {
  let adminBookId: string;
  let userBookId: string;

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
    await testDb.update(books).set({ createdBy: adminUserId }).where(eq(books.id, adminBookId));

    // Seed a book owned by regular user
    const { data: seedUser } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "User's Book", author: "User Author", status: "organized" }],
      },
    });
    userBookId = seedUser.inserted[0].id;
    await testDb.update(books).set({ createdBy: userUserId }).where(eq(books.id, userBookId));
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

  it("there is no such thing as an unowned book any more", async () => {
    // books.created_by is NOT NULL, so an unowned book is not a state the app
    // can reach. What is worth pinning is that the seeder cannot produce one
    // either: an unattributed book falls to the oldest admin, the same rule the
    // ingestion worker follows.
    const { data: seeded } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: [{ title: "Nobody Claimed It", author: "Nobody", status: "organized" }] },
    });

    const [row] = await testDb
      .select({ createdBy: books.createdBy })
      .from(books)
      .where(eq(books.id, seeded.inserted[0].id));
    expect(row.createdBy).toBe(adminUserId);
  });
});

// ── Credential Isolation ──────────────────────────────────────────

/**
 * Two changes since this block was written, both structural:
 *
 * 1. "opds" is no longer a credential service. OPDS clients authenticate with
 *    app passwords, so CredentialServiceParamSchema accepts only kosync and
 *    hardcover — a PUT to /api/credentials/opds is now a validation error.
 * 2. /api/credentials refuses app passwords, so these use
 *    sessions. A Bearer key would 403 before reaching the isolation logic and
 *    the test would pass for entirely the wrong reason.
 */
describe("credential isolation", () => {
  it("user A's credentials are invisible to user B", async () => {
    const { status: putStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass" },
      headers: adminSession(),
    });
    expect(putStatus).toBe(200);

    // Admin sees own credentials
    const { data: adminCred, status: adminStatus } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminSession(),
    });
    expect(adminStatus).toBe(200);
    expect(adminCred.configured).toBe(true);
    expect(adminCred.username).toBe("admin-kosync");

    // Regular user sees unconfigured (no credentials for their userId)
    const { data: userCred, status: userStatus } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userStatus).toBe(200);
    expect(userCred.configured).toBe(false);
  });

  it("opds is not a credential service any more", async () => {
    // It was the reason this block existed. OPDS readers hold an app password
    // now, so the service enum dropped it rather than leaving a dead row shape
    // that half the code still wrote to.
    const { status } = await $fetchRaw("/api/credentials/opds", {
      method: "PUT",
      body: { username: "admin-opds", password: "admin-pass" },
      headers: adminSession(),
    });
    expect(status).toBe(400);
  });

  it("each user can set independent credentials", async () => {
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass" },
      headers: adminSession(),
    });

    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass" },
      headers: userSession(),
    });

    // Verify each sees their own
    const { data: adminCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminSession(),
    });
    expect(adminCred.username).toBe("admin-kosync");

    const { data: userCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userCred.username).toBe("user-kosync");
  });

  it("deleting one user's credential does not affect the other", async () => {
    // Both users set credentials
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass" },
      headers: adminSession(),
    });
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass" },
      headers: userSession(),
    });

    // Delete admin's credential
    const { status: delStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "DELETE",
      headers: adminSession(),
    });
    expect(delStatus).toBe(200);

    // User's credential still exists
    const { data: userCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userCred.configured).toBe(true);
    expect(userCred.username).toBe("user-kosync");

    // Admin's credential is gone
    const { data: adminCred } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminSession(),
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
      headers: adminSession(),
      body: { username: "admin-kosync", password: "testpass" },
    });
  }

  async function seedKosyncForUser() {
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      headers: userSession(),
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
  it("reading progress rows are scoped per user via userId", async () => {
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
        userId: adminUserId,
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
      userId: userUserId,
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
      .where(eq(readingProgress.userId, adminUserId));
    expect(adminRows).toHaveLength(3);

    const userRows = await testDb
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.userId, userUserId));
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
      userId: adminUserId,
      lastStatus: "currently_reading",
      lastProgress: "0.5000",
      lastSyncedAt: new Date(),
    });

    await testDb.insert(hardcoverSyncLog).values({
      bookId,
      userId: userUserId,
      lastStatus: "want_to_read",
      lastProgress: "0.0000",
      lastSyncedAt: new Date(),
    });

    // Verify both entries exist with different statuses
    const adminLogs = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(eq(hardcoverSyncLog.userId, adminUserId));
    expect(adminLogs).toHaveLength(1);
    expect(adminLogs[0]!.lastStatus).toBe("currently_reading");

    const userLogs = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(eq(hardcoverSyncLog.userId, userUserId));
    expect(userLogs).toHaveLength(1);
    expect(userLogs[0]!.lastStatus).toBe("want_to_read");
  });
});

// ── Admin-Only Routes ─────────────────────────────────────────────

/**
 * Sessions throughout, deliberately.
 *
 * An app password is refused on admin routes whoever owns it, so a Bearer key
 * would make "non-admin gets 403" pass even if the role check were deleted.
 * These have to be about the PERSON to mean anything.
 */
describe("admin-only routes", () => {
  it("non-admin gets 403 on PATCH /api/settings", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: userSession(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on GET /api/jobs/status", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: userSession(),
    });
    expect(status).toBe(403);
  });

  it("admin can access GET /api/jobs/status", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: adminSession(),
    });
    expect(status).toBe(200);
  });

  it("non-admin can still GET /api/settings (read-only)", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      headers: userSession(),
    });
    expect(status).toBe(200);
  });

  it("refuses even the ADMIN's app password on an admin route", async () => {
    // Authority is not the only question on an admin route — the kind of
    // credential matters too.
    const { status } = await $fetchRaw("/api/jobs/status", { headers: adminAuth() });
    expect(status).toBe(403);
  });
});
