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
import { books, hardcoverSyncLog } from "../src/db/schema.js";
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

// ── KoSync credential helpers ─────────────────────────────────────

/** md5("testpass-strong") — the userkey KOReader sends once it has exchanged. */
const KOSYNC_KEY = "7b41a909c57c86088eb92f47bdd6dc67";
const KOSYNC_PASSWORD = "testpass-strong";

/** Give a person a KoSync username so their reader can sync as them. */
async function seedKosyncFor(session: Record<string, string>, username: string) {
  await $fetchRaw("/api/credentials/kosync", {
    method: "PUT",
    headers: session,
    body: { username, password: KOSYNC_PASSWORD },
  });
}

/** KOReader's own credential form: the non-standard x-auth-* header pair. */
function kosyncAuth(username: string) {
  return { "x-auth-user": username, "x-auth-key": KOSYNC_KEY };
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
  it("rejects a trivially weak KoSync password", async () => {
    const { data, status } = await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "weak-password-user", password: "short" },
      headers: adminSession(),
    });

    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain("at least 12 characters");
  });

  it("user A's credentials are invisible to user B", async () => {
    const { status: putStatus } = await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "admin-kosync", password: "admin-pass-strong" },
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
      body: { username: "admin-opds", password: "admin-pass-strong" },
      headers: adminSession(),
    });
    expect(status).toBe(400);
  });

  it("each user can set independent credentials", async () => {
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
      body: { username: "admin-kosync", password: "admin-pass-strong" },
      headers: adminSession(),
    });
    await $fetchRaw("/api/credentials/kosync", {
      method: "PUT",
      body: { username: "user-kosync", password: "user-pass-strong" },
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
  const seedKosyncForAdmin = () => seedKosyncFor(adminSession(), "admin-kosync");
  const seedKosyncForUser = () => seedKosyncFor(userSession(), "user-kosync");
  const adminKosyncAuth = () => kosyncAuth("admin-kosync");
  const userKosyncAuth = () => kosyncAuth("user-kosync");

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
//
// This block used to insert both users' reading_progress rows itself and then
// SELECT them straight back with the same userId filter it had just written
// (libris-59m.31). No src/ code ran, so "reading progress rows are scoped per
// user" was really an assertion that PostgreSQL honours a WHERE clause. It read
// as coverage of /api/stats, and would have stayed green with that endpoint's
// user scoping deleted.
//
// The header note claiming /api/stats is PGlite-incompatible is stale: the
// route carries a `rowsOf()` helper that normalises both driver shapes, so it
// answers here. It is driven for real below.

describe("reading stats isolation", () => {
  /** Seed `count` organized, finished books for one person, via the API. */
  async function seedFinished(
    session: Record<string, string>,
    titles: string[],
  ): Promise<string[]> {
    const { data: booksData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: titles.map((title) => ({ title, author: title, status: "organized" })) },
    });
    const ids: string[] = booksData.inserted.map((b: { id: string }) => b.id);

    await $fetchRaw("/__test/seed-files", {
      method: "POST",
      body: {
        files: ids.map((bookId, i) => ({
          bookId,
          format: "epub",
          originalName: `${titles[i]}.epub`,
          contentHash: `hash-${titles[i]}`,
        })),
      },
    });

    // Progress arrives the way it really does: over the KoSync route, as the
    // person who read it. That is what attributes it to a user.
    for (const title of titles) {
      await $fetchRaw("/kosync/syncs/progress", {
        method: "PUT",
        headers: session,
        body: { document: `hash-${title}`, progress: "end", device: "kindle", percentage: 0.98 },
      });
    }
    return ids;
  }

  it("counts only your own finished books in GET /api/stats", async () => {
    await seedKosyncFor(adminSession(), "admin-stats");
    await seedKosyncFor(userSession(), "user-stats");

    await seedFinished(kosyncAuth("admin-stats"), ["as1", "as2", "as3"]);
    await seedFinished(kosyncAuth("user-stats"), ["us1"]);

    const { data: adminStats, status: adminStatus } = await $fetchRaw("/api/stats", {
      headers: adminSession(),
    });
    expect(adminStatus).toBe(200);
    expect(adminStats.booksFinished.allTime).toBe(3);

    // The same four books exist for both people; only the progress differs.
    const { data: userStats, status: userStatus } = await $fetchRaw("/api/stats", {
      headers: userSession(),
    });
    expect(userStatus).toBe(200);
    expect(userStats.booksFinished.allTime).toBe(1);
  });

  it("shows a reader with no progress an empty stats page, not the library's", async () => {
    await seedKosyncFor(adminSession(), "admin-stats");
    await seedFinished(kosyncAuth("admin-stats"), ["as1", "as2"]);

    const { data: userStats } = await $fetchRaw("/api/stats", { headers: userSession() });
    expect(userStats.booksFinished.allTime).toBe(0);
  });
});

// ── Hardcover Sync Log Isolation ──────────────────────────────────
//
// Same rewrite as above: this inserted both users' hardcover_sync_log rows and
// selected them back by userId without involving the route (libris-59m.31).

describe("hardcover sync log isolation", () => {
  it("GET /api/hardcover/sync/log shows you only your own entries", async () => {
    const { data: seedData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: [{ title: "Shared Book", author: "Shared Author", status: "organized" }] },
    });
    const bookId = seedData.inserted[0].id;

    // The sync worker is what writes these; seeding them directly is fine
    // because the route's scoping is what is under test.
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

    const { data: adminLog, status: adminStatus } = await $fetchRaw("/api/hardcover/sync/log", {
      headers: adminSession(),
    });
    expect(adminStatus).toBe(200);
    expect(adminLog).toHaveLength(1);
    expect(adminLog[0]).toMatchObject({
      bookId,
      bookTitle: "Shared Book",
      status: "currently_reading",
    });

    const { data: userLog, status: userStatus } = await $fetchRaw("/api/hardcover/sync/log", {
      headers: userSession(),
    });
    expect(userStatus).toBe(200);
    expect(userLog).toHaveLength(1);
    expect(userLog[0]).toMatchObject({ bookId, status: "want_to_read" });
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
