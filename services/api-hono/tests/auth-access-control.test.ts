/**
 * Access control between two people.
 *
 * A person and their credentials are different objects: an account comes from
 * the admin plugin, and app passwords are things that account holds. App
 * passwords are also scoped — refused on admin routes, /api/auth/*,
 * /api/app-passwords and /api/credentials, whoever owns them.
 *
 * That decides which credential each test below uses, and it is not cosmetic: a
 * role assertion made with a Bearer key would pass even if the role check were
 * deleted, because the key is refused before the role is ever read. Role tests
 * use SESSIONS. Tests about the ordinary library surface use keys, because that
 * is what an e-reader holds.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { bootstrapAdmin, createAccount, createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { AppServices } from "../src/bootstrap.js";
import { and, eq } from "drizzle-orm";
import { books, readingProgress } from "../src/db/schema.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: AppServices;

// ── Per-test state ───────────────────────────────────────────────

/** The admin: their user id, an app password, and a browser session. */
let adminKey: string;
let adminUserId: string;
let adminCookie: string;

/** A second, non-admin person. */
let userKey: string;
let userUserId: string;
let userCookie: string;

function adminAuth() {
  return { authorization: `Bearer ${adminKey}` };
}

function userAuth() {
  return { authorization: `Bearer ${userKey}` };
}

function adminSession() {
  return { cookie: adminCookie };
}

function userSession() {
  return { cookie: userCookie };
}

// ── App lifecycle: create once ─────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
});

// ── Per-test lifecycle ─────────────────────────────────────────────

beforeEach(async () => {
  // includeAuth: several tests below count how many credentials a person holds,
  // which only means anything from an empty install.
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

// ═══════════════════════════════════════════════════════════════════
// 1. Admin vs non-admin access control
// ═══════════════════════════════════════════════════════════════════

describe("admin vs non-admin access control", () => {
  it("non-admin gets 403 on PATCH /api/settings", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: userSession(),
    });
    expect(status).toBe(403);
  });

  it("non-admin gets 403 on admin-only job management routes", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: userSession(),
    });
    expect(status).toBe(403);
  });

  it("admin can access PATCH /api/settings", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: adminSession(),
    });
    expect(status).toBe(200);
  });

  it("admin can access job management routes", async () => {
    const { status } = await $fetchRaw("/api/jobs/status", {
      headers: adminSession(),
    });
    expect(status).toBe(200);
  });

  it("minting a credential is not an admin power any more", async () => {
    // Issuing yourself a credential for your own e-reader needs no privilege.
    // Refusing it would mean a household member cannot connect a reader without
    // an admin doing it for them.
    const { status } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "their-own-reader" },
      headers: userSession(),
    });
    expect(status).toBe(201);
  });

  it("creating a PERSON still is", async () => {
    // The privilege did not disappear, it moved to the act it always belonged
    // to. Self-registration is disabled outright, so this is the only route in.
    await expect(
      services.auth.api.createUser({
        body: {
          email: "gatecrasher@example.test",
          password: "gatecrasher-password",
          name: "Gatecrasher",
          role: "user",
        },
        headers: new Headers(userSession()),
      }),
    ).rejects.toThrow();
  });

  it("nobody sees anyone else's credentials, admin included", async () => {
    // An admin manages accounts, not the credentials those accounts hold — they
    // can no more read a member's app passwords than read their password.
    const { data: userList, status } = await $fetchRaw("/api/app-passwords", {
      headers: userSession(),
    });
    expect(status).toBe(200);
    expect(userList.keys).toHaveLength(1);

    const { data: adminList } = await $fetchRaw("/api/app-passwords", {
      headers: adminSession(),
    });
    expect(adminList.keys).toHaveLength(1);
    expect(adminList.keys[0].id).not.toBe(userList.keys[0].id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Book ownership (requireBookOwnership)
// ═══════════════════════════════════════════════════════════════════

describe("book ownership (requireBookOwnership)", () => {
  let adminBookId: string;
  let userBookId: string;

  beforeEach(async () => {
    // Insert a book owned by admin
    const [adminBook] = await testDb
      .insert(books)
      .values({
        title: "Admin Book",
        author: "Admin Author",
        status: "review",
        createdBy: adminUserId,
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
        createdBy: userUserId,
      })
      .returning({ id: books.id });
    userBookId = userBook!.id;
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

  it("cannot create an unowned book at all", async () => {
    // created_by is NOT NULL, so there is no unowned-book case for
    // authorization to handle. The database is what enforces it.
    await expect(
      testDb
        .insert(books)
        .values({ title: "Unowned Book", author: "Unknown", status: "review" } as never),
    ).rejects.toThrow();
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

/**
 * The credential lifecycle, end to end: issue it, use it, revoke it, and watch
 * it stop working on the very next request.
 *
 * There is no "cannot delete your last credential" guard, deliberately — a
 * credential is disposable. The thing that must not be deleted is the last
 * ADMIN, which the admin plugin enforces and tests/e2e/auth.spec.ts covers.
 */
describe("app password lifecycle", () => {
  it("issue, use, revoke, and it is dead immediately", async () => {
    const { data: issued, status } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "lifecycle" },
      headers: userSession(),
    });
    expect(status).toBe(201);
    expect(issued).toMatchObject({ id: expect.any(String), key: expect.any(String) });

    const { status: before } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(before).toBe(200);

    const { status: revoked } = await $fetchRaw(`/api/app-passwords/${issued.id}`, {
      method: "DELETE",
      headers: userSession(),
    });
    expect(revoked).toBe(204);

    // No cache anywhere in the auth path, so "immediately" is literal — the old
    // middleware would have kept honouring this for up to five minutes.
    const { status: after } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(after).toBe(401);
  });

  it("the plaintext is returned once and never again", async () => {
    const { data: issued } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "write-once" },
      headers: userSession(),
    });
    expect(issued.key).toEqual(expect.any(String));

    const { data: listed } = await $fetchRaw("/api/app-passwords", { headers: userSession() });
    for (const entry of listed.keys) {
      expect(entry).not.toHaveProperty("key");
    }
  });

  it("an admin cannot revoke a member's credential — it is simply not found", async () => {
    const { data: theirs } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "members-reader" },
      headers: userSession(),
    });

    const { status } = await $fetchRaw(`/api/app-passwords/${theirs.id}`, {
      method: "DELETE",
      headers: adminSession(),
    });
    expect(status).toBe(404);

    // And it still works, so the 404 really was a refusal and not a silent success.
    const { status: stillWorks } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Bearer ${theirs.key}` },
    });
    expect(stillWorks).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Credential isolation
// ═══════════════════════════════════════════════════════════════════

/**
 * Sessions throughout: /api/credentials refuses app passwords,
 * so a Bearer key would 403 before any isolation logic ran.
 *
 * "opds" is also no longer one of these. OPDS readers hold an app password now,
 * so the service enum is kosync and hardcover only — the tests that used to
 * drive /api/credentials/opds were rewritten onto kosync rather than deleted,
 * because the isolation they check is still worth checking.
 */
describe("credential isolation", () => {
  it("user A sets credentials, user B cannot see them", async () => {
    const { status: putStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass" },
      headers: adminSession(),
    });
    expect(putStatus).toBe(200);

    // Admin can see their own credentials
    const { data: adminCreds, status: adminGetStatus } = await $fetchRaw(
      "/api/credentials/kosync",
      { headers: adminSession() },
    );
    expect(adminGetStatus).toBe(200);
    expect(adminCreds.configured).toBe(true);
    expect(adminCreds.username).toBe("admin-kosync");

    // Non-admin user cannot see admin's credentials
    const { data: userCreds, status: userGetStatus } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userGetStatus).toBe(200);
    expect(userCreds.configured).toBe(false);
  });

  it("user A and user B have independent credentials", async () => {
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

    // Each user sees only their own
    const { data: adminCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminSession(),
    });
    expect(adminCreds.configured).toBe(true);
    expect(adminCreds.username).toBe("admin-kosync");

    const { data: userCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userCreds.configured).toBe(true);
    expect(userCreds.username).toBe("user-kosync");
  });

  it("deleting user A credentials does not affect user B", async () => {
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

    // Admin deletes their own kosync credentials
    const { status: deleteStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "DELETE",
      headers: adminSession(),
    });
    expect(deleteStatus).toBe(200);

    // Admin's credentials are gone
    const { data: adminCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: adminSession(),
    });
    expect(adminCreds.configured).toBe(false);

    // User's credentials are still intact
    const { data: userCreds } = await $fetchRaw("/api/credentials/kosync", {
      headers: userSession(),
    });
    expect(userCreds.configured).toBe(true);
    expect(userCreds.username).toBe("user-kosync");
  });

  it("user cannot delete credentials they don't own (returns 404)", async () => {
    // Admin sets Hardcover credentials
    await $fetchRaw("/api/credentials/hardcover", {
      method: "PUT",
      body: { username: "admin-hc", password: "admin-token" },
      headers: adminSession(),
    });

    // User tries to delete (they have no hardcover credentials)
    const { status } = await $fetchRaw("/api/credentials/hardcover", {
      method: "DELETE",
      headers: userSession(),
    });
    expect(status).toBe(404);

    // Admin's credentials are still there
    const { data: adminCreds } = await $fetchRaw("/api/credentials/hardcover", {
      headers: adminSession(),
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
// to verify the schema correctly partitions progress by userId.

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
        createdBy: adminUserId,
      })
      .returning({ id: books.id });
    bookId = book!.id;
  });

  it("two users can have independent reading progress on the same book", async () => {
    // Insert reading progress for admin (80%)
    await testDb.insert(readingProgress).values({
      bookId,
      userId: adminUserId,
      document: "shared-book.epub",
      device: "admin-device",
      progress: "/body/chapter[8]",
      percentage: "0.8000",
      timestamp: BigInt(Date.now()),
    });

    // Insert reading progress for user (30%) - same document, different device/user
    await testDb.insert(readingProgress).values({
      bookId,
      userId: userUserId,
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
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, adminUserId)));
    expect(adminRows).toHaveLength(1);
    expect(Number(adminRows[0]!.percentage)).toBeCloseTo(0.8, 2);

    // Query user's progress
    const userRows = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, userUserId)));
    expect(userRows).toHaveLength(1);
    expect(Number(userRows[0]!.percentage)).toBeCloseTo(0.3, 2);
  });

  it("per-user unique constraint allows same document+device for different users", async () => {
    // Both users reading the same document on same-named device
    await testDb.insert(readingProgress).values({
      bookId,
      userId: adminUserId,
      document: "shared-book.epub",
      device: "shared-device",
      progress: "/body/chapter[8]",
      percentage: "0.8000",
      timestamp: BigInt(Date.now()),
    });

    // Should NOT violate unique constraint because userId is different
    await testDb.insert(readingProgress).values({
      bookId,
      userId: userUserId,
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
      userId: adminUserId,
      document: "shared-book.epub",
      device: "admin-device",
      progress: "/body/chapter[5]",
      percentage: "0.5000",
      timestamp: BigInt(Date.now()),
    });
    await testDb.insert(readingProgress).values({
      bookId,
      userId: userUserId,
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
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, adminUserId)));

    // User's progress should be unchanged
    const [userRow] = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, userUserId)));
    expect(Number(userRow!.percentage)).toBeCloseTo(0.2, 2);

    // Admin's progress should be updated
    const [adminRow] = await testDb
      .select({ percentage: readingProgress.percentage })
      .from(readingProgress)
      .where(and(eq(readingProgress.bookId, bookId), eq(readingProgress.userId, adminUserId)));
    expect(Number(adminRow!.percentage)).toBeCloseTo(0.99, 2);
  });
});
