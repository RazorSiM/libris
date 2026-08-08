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
      body: { username: "admin-kosync", password: "admin-pass-strong" },
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
      body: { username: "admin-kosync", password: "admin-pass-strong" },
      headers: adminSession(),
    });

    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass-strong" },
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
      body: { username: "admin-kosync", password: "admin-pass-strong" },
      headers: adminSession(),
    });
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass-strong" },
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
      body: { username: "admin-hc", password: "admin-token-long" },
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
// These blocks used to insert both users' rows themselves, run their own
// UPDATE, and then assert the other row was untouched (libris-59m.31). No
// application code ran, so they held whatever the KoSync routes did — the
// invariant was really being kept by schema.ts's per-user unique index, and
// the tests would have stayed green with the routes' user scoping deleted.
//
// They drive `/kosync/syncs/progress` now: the PUT is the real upsert (whose
// ON CONFLICT target is what partitions two readers), and every assertion
// reads the value back out through the GET (whose WHERE clause is the other
// half). One DB-level test survives, renamed to say plainly that it pins the
// schema rather than the routes.

describe("reading progress isolation", () => {
  /** md5("testpass-strong") — the userkey KOReader sends after the exchange. */
  const KOSYNC_KEY = "7b41a909c57c86088eb92f47bdd6dc67";
  const KOSYNC_PASSWORD = "testpass-strong";
  /** Matches the seeded file's content hash, so the upsert resolves a book id. */
  const DOCUMENT = "shared-book-content-hash";

  let bookId: string;

  beforeEach(async () => {
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

    await $fetchRaw("/__test/seed-files", {
      method: "POST",
      body: {
        files: [
          {
            bookId,
            format: "epub",
            originalName: "shared-book.epub",
            contentHash: DOCUMENT,
          },
        ],
      },
    });

    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      headers: adminSession(),
      body: { username: "admin-kosync", password: KOSYNC_PASSWORD },
    });
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      headers: userSession(),
      body: { username: "user-kosync", password: KOSYNC_PASSWORD },
    });
  });

  /** KOReader's own credential form: the non-standard x-auth-* header pair. */
  const adminReader = () => ({ "x-auth-user": "admin-kosync", "x-auth-key": KOSYNC_KEY });
  const userReader = () => ({ "x-auth-user": "user-kosync", "x-auth-key": KOSYNC_KEY });

  function sync(
    headers: Record<string, string>,
    body: { device: string; progress: string; percentage: number },
  ) {
    return $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers,
      body: { document: DOCUMENT, ...body },
    });
  }

  /** Deliberately a second request: the point is what was PERSISTED. */
  function readBack(headers: Record<string, string>) {
    return $fetchRaw(`/kosync/syncs/progress/${DOCUMENT}`, { headers });
  }

  it("each reader is served its own progress, not whichever row is newest", async () => {
    expect(
      (await sync(adminReader(), { device: "kobo", progress: "/ch[8]", percentage: 0.8 })).status,
    ).toBe(200);
    expect(
      (await sync(userReader(), { device: "kindle", progress: "/ch[3]", percentage: 0.3 })).status,
    ).toBe(200);

    const admin = await readBack(adminReader());
    expect(admin.status).toBe(200);
    expect(admin.data.percentage).toBe(0.8);

    const member = await readBack(userReader());
    expect(member.status).toBe(200);
    expect(member.data.percentage).toBe(0.3);
  });

  it("the same device name on two accounts is two rows, not one", async () => {
    // Both people call their reader "kindle". Only the userId in the upsert's
    // conflict target keeps the second sync from overwriting the first.
    await sync(adminReader(), { device: "kindle", progress: "/ch[8]", percentage: 0.8 });
    await sync(userReader(), { device: "kindle", progress: "/ch[3]", percentage: 0.3 });

    expect((await readBack(adminReader())).data.percentage).toBe(0.8);
    expect((await readBack(userReader())).data.percentage).toBe(0.3);

    const stored = await testDb
      .select({ userId: readingProgress.userId })
      .from(readingProgress)
      .where(eq(readingProgress.document, DOCUMENT));
    expect(stored.map(({ userId }) => userId).sort()).toEqual([adminUserId, userUserId].sort());
  });

  it("one reader syncing again does not move the other reader's place", async () => {
    await sync(adminReader(), { device: "kobo", progress: "/ch[5]", percentage: 0.5 });
    await sync(userReader(), { device: "kindle", progress: "/ch[2]", percentage: 0.2 });

    // The second sync from the same device takes the ON CONFLICT branch.
    await sync(adminReader(), { device: "kobo", progress: "/ch[10]", percentage: 0.99 });

    expect((await readBack(userReader())).data.percentage).toBe(0.2);
    expect((await readBack(adminReader())).data.percentage).toBe(0.99);
  });

  it("resolves the document to the book so progress is not orphaned", async () => {
    await sync(adminReader(), { device: "kobo", progress: "/ch[1]", percentage: 0.1 });

    const [stored] = await testDb
      .select({ bookId: readingProgress.bookId })
      .from(readingProgress)
      .where(and(eq(readingProgress.document, DOCUMENT), eq(readingProgress.userId, adminUserId)));
    expect(stored?.bookId).toBe(bookId);
  });

  it("SCHEMA: the per-user unique index is what makes those two rows possible", async () => {
    // Not a test of any route — it pins reading_progress_user_document_device_uniq
    // directly, because the upsert above is only correct while the constraint it
    // names has userId in it. Named so nobody reads it as endpoint coverage.
    const row = {
      bookId,
      document: DOCUMENT,
      device: "shared-device",
      progress: "/ch[1]",
      percentage: "0.1000",
      timestamp: BigInt(Date.now()),
    };

    await testDb.insert(readingProgress).values({ ...row, userId: adminUserId });
    // Different user, same (document, device): allowed.
    await testDb.insert(readingProgress).values({ ...row, userId: userUserId });
    // Same user, same (document, device): refused.
    await expect(
      testDb.insert(readingProgress).values({ ...row, userId: adminUserId }),
    ).rejects.toThrow();

    const stored = await testDb
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.device, "shared-device"));
    expect(stored).toHaveLength(2);
  });
});
