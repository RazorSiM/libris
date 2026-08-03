import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { bootstrapAdmin, createTestApp, createFetchHelper, TEST_PASSWORD } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { AppServices } from "../src/bootstrap.js";
import {
  books,
  readingAggregate,
  readingProgress,
  readingProgressHistory,
} from "../src/db/schema.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: AppServices;

// ── Per-test state ───────────────────────────────────────────────

let apiKey: string;
let userId: string;
let cookie: string;

/** An app password — the library surface, and what an e-reader holds. */
function auth() {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * A browser session, for the routes app passwords are scoped out of
 *: admin routes, /api/auth/*, /api/app-passwords and
 * /api/credentials.
 */
function session() {
  return { cookie };
}

// ── App lifecycle: create once ─────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
});

// ── Per-test lifecycle: clean DB → bootstrap the admin ─────────────

beforeEach(async () => {
  // includeAuth so each test starts from a genuinely empty install — the setup
  // and app-password tests below both count what exists.
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });

  // POST /api/auth/setup took a key label and returned a raw key, because a key
  // was a user. Creating the admin and issuing them a credential are separate
  // acts now; bootstrapAdmin does both and hands back a session too.
  const admin = await bootstrapAdmin(services, $fetchRaw);
  apiKey = admin.rawKey;
  userId = admin.userId;
  cookie = admin.cookie;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });
});

// ── Auth: first-run setup ──────────────────────────────────────────

describe("POST /api/setup", () => {
  it("closes for good once any user exists", async () => {
    // beforeEach already bootstrapped the admin, so this is the second call.
    // The route is public by design — it has to be, nobody can authenticate on
    // a fresh install — so the 409 is the only thing standing between a public
    // endpoint and anyone minting themselves an admin account.
    const { status } = await $fetchRaw("/api/setup", {
      method: "POST",
      body: { email: "second@example.test", password: TEST_PASSWORD, name: "Second" },
    });
    expect(status).toBe(409);
  });
});

// ── Auth middleware ─────────────────────────────────────────────────
// Test against /api/inbox — no route-rule caching

describe("auth middleware", () => {
  it("rejects requests without Authorization header", async () => {
    const { status } = await $fetchRaw("/api/inbox");
    expect(status).toBe(401);
  });

  it("rejects requests with invalid API key", async () => {
    const { status } = await $fetchRaw("/api/inbox", {
      headers: { authorization: "Bearer totally-invalid-key-0000000000000000" },
    });
    expect(status).toBe(401);
  });

  it("accepts valid Bearer token", async () => {
    const { status } = await $fetchRaw("/api/inbox", {
      headers: auth(),
    });
    expect(status).toBe(200);
  });

  it("accepts Basic auth (OPDS clients)", async () => {
    const encoded = Buffer.from(`${apiKey}:${apiKey}`).toString("base64");
    const { status } = await $fetchRaw("/api/inbox", {
      headers: { authorization: `Basic ${encoded}` },
    });
    expect(status).toBe(200);
  });

  it("allows /api/health without auth (optional auth route)", async () => {
    const { status } = await $fetchRaw("/api/health");
    expect(status).toBe(200);
  });
});

// ── App password management ────────────────────────────────────────

/**
 * Sessions, not `auth()`: /api/app-passwords refuses app passwords, so a
 * credential cannot mint or revoke credentials.
 */
describe("app password management", () => {
  it("POST /api/app-passwords — issues one, plaintext included", async () => {
    const { data, status } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "second-key" },
      headers: session(),
    });
    expect(status).toBe(201);
    expect(data).toMatchObject({
      id: expect.any(String),
      key: expect.any(String),
      name: "second-key",
    });
  });

  it("GET /api/app-passwords — lists them without exposing the secret", async () => {
    for (const name of ["second-key", "third-key"]) {
      await $fetchRaw("/api/app-passwords", {
        method: "POST",
        body: { name },
        headers: session(),
      });
    }

    const { data, status } = await $fetchRaw("/api/app-passwords", { headers: session() });
    expect(status).toBe(200);
    expect(data.keys).toBeInstanceOf(Array);
    expect(data.keys.length).toBeGreaterThanOrEqual(3);
    for (const k of data.keys) {
      // `key` holds a plugin-computed hash and must never leave the server;
      // `start` is a few plaintext characters, which is how the UI tells two
      // credentials apart in a list.
      expect(k).not.toHaveProperty("key");
      expect(k).not.toHaveProperty("keyHash");
      expect(k).toHaveProperty("id");
      expect(k).toHaveProperty("name");
      expect(k).toHaveProperty("createdAt");
    }
  });

  it("DELETE /api/app-passwords/:id — revoking the one you are using is allowed", async () => {
    // Revoking the credential you are authenticating with is allowed: it costs
    // you that credential and nothing else, and the session doing the revoking
    // is untouched.
    const { data: list } = await $fetchRaw("/api/app-passwords", { headers: session() });
    const active = list.keys.find((k: { id: string }) => k.id);

    const { status } = await $fetchRaw(`/api/app-passwords/${active.id}`, {
      method: "DELETE",
      headers: session(),
    });
    expect(status).toBe(204);
    expect((await $fetchRaw("/api/inbox", { headers: auth() })).status).toBe(401);
  });

  it("DELETE /api/app-passwords/:id — revokes one, 204 with no body", async () => {
    const { data: created } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "second-key" },
      headers: session(),
    });

    const { data, status } = await $fetchRaw(`/api/app-passwords/${created.id}`, {
      method: "DELETE",
      headers: session(),
    });
    expect(status).toBe(204);
    expect(data).toBeNull();
  });

  it("DELETE /api/app-passwords/:id — 404 for an id that is not yours or not real", async () => {
    const { status } = await $fetchRaw("/api/app-passwords/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: session(),
    });
    expect(status).toBe(404);
  });
});

// ── Health ──────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns minimal status without auth", async () => {
    const { data, status } = await $fetchRaw("/api/health");
    expect(status).toBe(200);
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("service", "api");
    expect(data).not.toHaveProperty("checks");
  });

  it("returns detailed checks with auth", async () => {
    const { data, status } = await $fetchRaw("/api/health", {
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("service", "api");
    expect(data).toHaveProperty("checks");
    expect(data.checks).toHaveProperty("database");
    expect(data.checks).toHaveProperty("redis");
  });
});

// ── Settings ───────────────────────────────────────────────────────

describe("settings", () => {
  it("GET /api/settings — returns current paths and Hardcover toggles", async () => {
    const { data, status } = await $fetchRaw("/api/settings", {
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data).toHaveProperty("libraryPath");
    expect(data).toHaveProperty("inboxPath");
    expect(data).toHaveProperty("hardcoverMetadataEnabled");
    expect(data).toHaveProperty("hardcoverSyncEnabled");
    expect(typeof data.hardcoverMetadataEnabled).toBe("boolean");
    expect(typeof data.hardcoverSyncEnabled).toBe("boolean");
  });

  it("PATCH /api/settings — updates Hardcover toggles", async () => {
    // Disable sync
    const { data, status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: false },
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data.updated).toContain("hardcoverSyncEnabled");

    // Verify it persisted
    const { data: get } = await $fetchRaw("/api/settings", {
      headers: auth(),
    });
    expect(get.hardcoverSyncEnabled).toBe(false);

    // Re-enable for other tests
    await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: { hardcoverSyncEnabled: true },
      headers: auth(),
    });
  });

  it("PATCH /api/settings — rejects empty body", async () => {
    const { status } = await $fetchRaw("/api/settings", {
      method: "PATCH",
      body: {},
      headers: auth(),
    });
    expect(status).toBe(400);
  });
});

// ── Jobs ───────────────────────────────────────────────────────────

describe("GET /api/jobs/status", () => {
  it("returns queue counts", async () => {
    const { data, status } = await $fetchRaw("/api/jobs/status", {
      headers: session(),
    });
    expect(status).toBe(200);
    expect(data).toHaveProperty("queues");
    for (const counts of Object.values(data.queues) as any[]) {
      expect(counts).toMatchObject({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });
    }
  });
});

describe("GET /api/jobs/:id (queueName disambiguation)", () => {
  it("400 when queueName query param is missing", async () => {
    const { status } = await $fetchRaw("/api/jobs/1", { headers: session() });
    expect(status).toBe(400);
  });

  it("404 when queueName does not match a registered queue", async () => {
    const { data, status } = await $fetchRaw("/api/jobs/1?queueName=does-not-exist", {
      headers: session(),
    });
    expect(status).toBe(404);
    expect(data.error).toMatch(/Queue "does-not-exist" not found/);
  });
});

describe("GET /api/jobs/:id/logs (queueName disambiguation)", () => {
  it("400 when queueName query param is missing", async () => {
    const { status } = await $fetchRaw("/api/jobs/1/logs", { headers: session() });
    expect(status).toBe(400);
  });

  it("404 when queueName does not match a registered queue", async () => {
    const { status } = await $fetchRaw("/api/jobs/1/logs?queueName=does-not-exist", {
      headers: session(),
    });
    expect(status).toBe(404);
  });
});

describe("POST /api/jobs/:id/retry (queueName disambiguation)", () => {
  it("400 when queueName query param is missing", async () => {
    const { status } = await $fetchRaw("/api/jobs/1/retry", {
      method: "POST",
      headers: session(),
    });
    expect(status).toBe(400);
  });

  it("404 when queueName does not match a registered queue", async () => {
    const { status } = await $fetchRaw("/api/jobs/1/retry?queueName=does-not-exist", {
      method: "POST",
      headers: session(),
    });
    expect(status).toBe(404);
  });
});

// ── Inbox ──────────────────────────────────────────────────────────

describe("inbox", () => {
  it("GET /api/inbox — returns empty list", async () => {
    const { data, status } = await $fetchRaw("/api/inbox", {
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination).toMatchObject({
      page: 1,
      total: 0,
      totalPages: 0,
    });
  });

  it("GET /api/inbox — handles search params", async () => {
    const { data, status } = await $fetchRaw("/api/inbox?q=test&page=1&limit=10", {
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data.pagination.limit).toBe(10);
  });

  it("GET /api/inbox/:id — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/inbox/00000000-0000-0000-0000-000000000000", {
      headers: auth(),
    });
    expect(status).toBe(404);
  });

  it("PATCH /api/inbox/:id/rescan — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/inbox/00000000-0000-0000-0000-000000000000/rescan", {
      method: "PATCH",
      headers: auth(),
    });
    expect(status).toBe(404);
  });
});

// ── Library ────────────────────────────────────────────────────────

describe("library", () => {
  it("GET /api/library — returns empty list", async () => {
    const { data, status } = await $fetchRaw("/api/library", {
      headers: auth(),
    });
    expect(status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.pagination).toMatchObject({
      page: 1,
      total: 0,
      totalPages: 0,
    });
  });

  it("GET /api/library — handles search and filter params", async () => {
    const { data, status } = await $fetchRaw(
      "/api/library?q=test&author=Tolkien&genre=Fantasy&page=1&limit=5",
      { headers: auth() },
    );
    expect(status).toBe(200);
    expect(data.pagination.limit).toBe(5);
  });

  it("GET /api/library/:id — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/library/00000000-0000-0000-0000-000000000000", {
      headers: auth(),
    });
    expect(status).toBe(404);
  });

  it("PATCH /api/library/:id — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/library/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      body: { title: "Updated Title" },
      headers: auth(),
    });
    expect(status).toBe(404);
  });

  it("POST /api/library/:id/reorganize — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw(
      "/api/library/00000000-0000-0000-0000-000000000000/reorganize",
      { method: "POST", headers: auth() },
    );
    expect(status).toBe(404);
  });
});

// ── Books (metadata review) ────────────────────────────────────────

describe("books", () => {
  it("GET /api/books/:id/candidates — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw(
      "/api/books/00000000-0000-0000-0000-000000000000/candidates",
      { headers: auth() },
    );
    expect(status).toBe(404);
  });

  it("POST /api/books/:id/approve — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/books/00000000-0000-0000-0000-000000000000/approve", {
      method: "POST",
      body: { fields: { title: { source: "manual", value: "Test" } } },
      headers: auth(),
    });
    expect(status).toBe(404);
  });

  it("DELETE /api/books/:id — 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/api/books/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: auth(),
    });
    expect(status).toBe(404);
  });

  it("POST /api/books/:id/approve — 409 when book is not in review status", async () => {
    // Seed a book in inbox status (not review)
    const { data: seedData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: [{ title: "Inbox Book", author: "Author", status: "inbox" }] },
    });
    const bookId = seedData.inserted[0].id;

    const { status } = await $fetchRaw(`/api/books/${bookId}/approve`, {
      method: "POST",
      body: { fields: { title: { source: "manual", value: "Test" } } },
      headers: auth(),
    });
    expect(status).toBe(409);
  });

  it("POST /api/books/:id/approve — approves book and enqueues organize job", async () => {
    // 1. Seed a book in review status
    const { data: seedData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [{ title: "Draft Title", author: "Unknown", status: "review" }],
      },
    });
    const bookId = seedData.inserted[0].id;

    // 2. Seed metadata candidates for the book
    await $fetchRaw("/__test/seed-candidates", {
      method: "POST",
      body: {
        candidates: [
          {
            bookId,
            source: "hardcover",
            normalized: {
              title: "The Hobbit",
              author: "J.R.R. Tolkien",
              isbn13: "9780547928227",
              language: "en",
            },
            confidence: "0.9",
          },
          {
            bookId,
            source: "open_library",
            normalized: {
              title: "The Hobbit",
              author: "J. R. R. Tolkien",
              publisher: "Houghton Mifflin",
              publishedYear: 1937,
            },
            confidence: "0.8",
          },
        ],
      },
    });

    // 3. Approve with fields from different sources (including manual)
    const { data, status } = await $fetchRaw(`/api/books/${bookId}/approve`, {
      method: "POST",
      body: {
        fields: {
          title: { source: "hardcover", value: "The Hobbit" },
          author: { source: "hardcover", value: "J.R.R. Tolkien" },
          isbn13: { source: "hardcover", value: "9780547928227" },
          publisher: { source: "open_library", value: "Houghton Mifflin" },
          language: { source: "manual", value: "en" },
        },
      },
      headers: auth(),
    });

    // 4. Verify response: book is now organized with approved metadata
    expect(status).toBe(200);
    expect(data).toMatchObject({
      id: bookId,
      status: "organized",
      title: "The Hobbit",
      author: "J.R.R. Tolkien",
      isbn13: "9780547928227",
      publisher: "Houghton Mifflin",
      language: "en",
    });
    expect(data.approvedAt).toBeTruthy();

    // 5. Verify book is accessible via library detail endpoint (status = organized)
    const { data: libraryBook, status: libStatus } = await $fetchRaw(`/api/library/${bookId}`, {
      headers: auth(),
    });
    expect(libStatus).toBe(200);
    expect(libraryBook).toMatchObject({
      id: bookId,
      status: "organized",
      title: "The Hobbit",
    });
  });

  it("POST /api/books/:id/approve — 400 when no valid fields provided", async () => {
    const { data: seedData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: { books: [{ title: "Review Book", status: "review" }] },
    });
    const bookId = seedData.inserted[0].id;

    const { status } = await $fetchRaw(`/api/books/${bookId}/approve`, {
      method: "POST",
      body: { fields: { invalidField: { source: "manual", value: "test" } } },
      headers: auth(),
    });
    expect(status).toBe(400);
  });
});

// ── KoSync ──────────────────────────────────────────────────────────
// KoSync uses its own auth (x-auth-user / x-auth-key headers), not API keys.
// Credentials are seeded via the credentials API in each test.

// KOReader sends md5(password) as x-auth-key.
const TESTPASS_MD5 = "7b41a909c57c86088eb92f47bdd6dc67"; // md5("testpass-strong")

function kosyncAuth() {
  return { "x-auth-user": "testuser", "x-auth-key": TESTPASS_MD5 };
}

/** Seed KoSync credentials via the API. Session: /api/credentials refuses keys. */
async function seedKosyncCredentials() {
  await $fetchRaw("/api/credentials/kosync", {
    method: "PUT",
    headers: session(),
    body: { username: "testuser", password: "testpass-strong" },
  });
}

/**
 * What an OPDS reader sends.
 *
 * A reader authenticates with an ordinary app password in Basic's PASSWORD
 * field. The username half is informational, which is why the default here is
 * the account's email rather than a second secret.
 */
function opdsBasicAuth(username = "integration-test@example.test", password?: string) {
  const encoded = Buffer.from(`${username}:${password ?? apiKey}`).toString("base64");
  return { authorization: `Basic ${encoded}` };
}

describe("KoSync: GET /kosync/users/auth", () => {
  beforeEach(seedKosyncCredentials);

  it("authenticates with valid x-auth-user / x-auth-key headers", async () => {
    const { data, status } = await $fetchRaw("/kosync/users/auth", {
      method: "GET",
      headers: kosyncAuth(),
    });
    expect(status).toBe(200);
    expect(data).toEqual({ authorized: "OK", userkey: TESTPASS_MD5 });
  });

  it("rejects wrong password in headers", async () => {
    const { status } = await $fetchRaw("/kosync/users/auth", {
      method: "GET",
      headers: { "x-auth-user": "testuser", "x-auth-key": "wrongpass" },
    });
    expect(status).toBe(401);
  });

  it("rejects missing auth headers", async () => {
    const { status } = await $fetchRaw("/kosync/users/auth", {
      method: "GET",
    });
    expect(status).toBe(401);
  });
});

describe("KoSync: POST /kosync/users/auth", () => {
  beforeEach(seedKosyncCredentials);

  it("authenticates with valid credentials", async () => {
    const { data, status } = await $fetchRaw("/kosync/users/auth", {
      method: "POST",
      body: { username: "testuser", password: "testpass-strong" },
    });
    expect(status).toBe(200);
    expect(data).toEqual({ authorized: "OK", userkey: TESTPASS_MD5 });
  });

  it("rejects wrong password", async () => {
    const { status } = await $fetchRaw("/kosync/users/auth", {
      method: "POST",
      body: { username: "testuser", password: "wrongpass" },
    });
    expect(status).toBe(401);
  });

  it("rejects wrong username", async () => {
    const { status } = await $fetchRaw("/kosync/users/auth", {
      method: "POST",
      body: { username: "wronguser", password: "testpass-strong" },
    });
    expect(status).toBe(401);
  });

  it("rejects missing body fields", async () => {
    const { status } = await $fetchRaw("/kosync/users/auth", {
      method: "POST",
      body: {},
    });
    expect(status).toBe(400);
  });
});

describe("KoSync: POST /kosync/users/create", () => {
  it("returns 409 (registration always disabled)", async () => {
    const { status } = await $fetchRaw("/kosync/users/create", {
      method: "POST",
      body: { username: "newuser", password: "newpass" },
    });
    expect(status).toBe(409);
  });
});

describe("KoSync: PUT /kosync/syncs/progress", () => {
  beforeEach(seedKosyncCredentials);

  it("creates reading progress", async () => {
    const { data, status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "test-book.epub",
        progress: "/body/chapter[1]",
        device: "kindle",
        percentage: 0.25,
        device_id: "kindle-123",
      },
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({
      document: "test-book.epub",
      progress: "/body/chapter[1]",
      percentage: 0.25,
      device: "kindle",
      device_id: "kindle-123",
    });
    expect(data.timestamp).toBeGreaterThan(0);
  });

  it("upserts existing progress for same document+device", async () => {
    // Create initial progress
    await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "test-book.epub",
        progress: "/body/chapter[1]",
        device: "kindle",
        percentage: 0.25,
      },
    });

    // Update same document+device
    const { data, status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "test-book.epub",
        progress: "/body/chapter[5]",
        device: "kindle",
        percentage: 0.75,
      },
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({
      document: "test-book.epub",
      progress: "/body/chapter[5]",
      percentage: 0.75,
      device: "kindle",
    });
  });

  it("rejects without auth headers", async () => {
    const { status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      body: {
        document: "test-book.epub",
        progress: "/body/chapter[1]",
        device: "kindle",
      },
    });
    expect(status).toBe(401);
  });

  it("rejects invalid body", async () => {
    const { status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: { document: "" },
    });
    expect(status).toBe(400);
  });

  it("populates book_id when document matches a known file", async () => {
    // Seed an organized book
    const { data: bookData } = await $fetchRaw("/__test/seed-books", {
      method: "POST",
      headers: auth(),
      body: { books: [{ title: "KoReader Book", status: "organized" }] },
    });
    const bookId = bookData.inserted[0].id;

    // Seed a file with a known content hash
    await $fetchRaw("/__test/seed-files", {
      method: "POST",
      headers: auth(),
      body: {
        files: [
          {
            bookId,
            format: "epub",
            originalName: "book.epub",
            contentHash: "test-content-hash-abc123",
          },
        ],
      },
    });

    // PUT progress using that content hash as the document identifier
    const { status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "test-content-hash-abc123",
        progress: "/body/p[5]",
        device: "kobo",
        percentage: 0.3,
      },
    });
    expect(status).toBe(200);

    // Verify book_id was resolved and stored
    const [row] = await testDb
      .select({ bookId: readingProgress.bookId })
      .from(readingProgress)
      .where(eq(readingProgress.document, "test-content-hash-abc123"));
    expect(row!.bookId).toBe(bookId);
  });

  it("keeps the sync response non-blocking when history insert fails", async () => {
    const originalInsert = testDb.insert.bind(testDb);
    vi.spyOn(testDb, "insert").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (table: any) => {
        if (table === readingProgressHistory) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return {
            values: () => Promise.reject(new Error("history write failed")),
          } as any;
        }

        return originalInsert(table);
      },
    );

    const { data, status } = await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "history-failure-book.epub",
        progress: "/body/chapter[2]",
        device: "kobo",
        percentage: 0.4,
      },
    });

    expect(status).toBe(200);
    expect(data).toMatchObject({
      document: "history-failure-book.epub",
      progress: "/body/chapter[2]",
      percentage: 0.4,
      device: "kobo",
    });

    const [row] = await testDb
      .select({ document: readingProgress.document })
      .from(readingProgress)
      .where(eq(readingProgress.document, "history-failure-book.epub"));
    expect(row?.document).toBe("history-failure-book.epub");
  });
});

describe("KoSync: GET /kosync/syncs/progress/:document", () => {
  beforeEach(seedKosyncCredentials);

  it("returns latest reading progress", async () => {
    // Create progress first
    await $fetchRaw("/kosync/syncs/progress", {
      method: "PUT",
      headers: kosyncAuth(),
      body: {
        document: "get-test-book.epub",
        progress: "/body/chapter[3]",
        device: "kobo",
        percentage: 0.5,
      },
    });

    const { data, status } = await $fetchRaw("/kosync/syncs/progress/get-test-book.epub", {
      headers: kosyncAuth(),
    });
    expect(status).toBe(200);
    expect(data).toMatchObject({
      document: "get-test-book.epub",
      progress: "/body/chapter[3]",
      percentage: 0.5,
      device: "kobo",
    });
  });

  it("returns 404 for non-existent document", async () => {
    const { status } = await $fetchRaw("/kosync/syncs/progress/nonexistent-book.epub", {
      headers: kosyncAuth(),
    });
    expect(status).toBe(404);
  });

  it("rejects without auth headers", async () => {
    const { status } = await $fetchRaw("/kosync/syncs/progress/test-book.epub");
    expect(status).toBe(401);
  });
});

// ── OPDS Feed ──────────────────────────────────────────────────────
// OPDS routes return Atom XML feeds for e-reader clients.
// OPDS requires Basic auth with service credentials (set via Settings UI).
// /opds/download/* is unauthenticated (loaded by <a> tags).

/** Seed organized books with file records for OPDS testing. */
async function seedOpdsBooks() {
  const { data: seedData } = await $fetchRaw("/__test/seed-books", {
    method: "POST",
    body: {
      books: [
        {
          title: "The Hobbit",
          author: "J.R.R. Tolkien",
          description: "A hobbit goes on an adventure",
          genres: ["Fantasy", "Adventure"],
          status: "organized",
        },
        {
          title: "Dune",
          author: "Frank Herbert",
          description: "Desert planet politics",
          genres: ["Science Fiction"],
          status: "organized",
        },
        {
          title: "Inbox Book",
          author: "Not Organized",
          status: "inbox",
        },
      ],
    },
  });

  const hobbitId = seedData.inserted[0].id;
  const duneId = seedData.inserted[1].id;

  // Seed file records for the organized books
  const { data: fileData } = await $fetchRaw("/__test/seed-files", {
    method: "POST",
    body: {
      files: [
        {
          bookId: hobbitId,
          format: "epub",
          originalName: "the-hobbit.epub",
          storagePath: "Tolkien/the-hobbit.epub",
        },
        {
          bookId: duneId,
          format: "epub",
          originalName: "dune.epub",
          storagePath: "Herbert/dune.epub",
        },
      ],
    },
  });

  return {
    hobbitId,
    duneId,
    inboxId: seedData.inserted[2].id,
    files: fileData.inserted,
  };
}

describe("OPDS: GET /opds/ (index feed)", () => {
  it("returns OPDS navigation feed with Basic auth", async () => {
    const { data, status, headers } = await $fetchRaw("/opds/", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/atom+xml");
    expect(data).toContain('<?xml version="1.0"');
    expect(data).toContain("<feed");
    expect(data).toContain('xmlns="http://www.w3.org/2005/Atom"');
    expect(data).toContain("</feed>");
  });

  it("contains navigation entries for New Arrivals, All Books, and Genres", async () => {
    const { data } = await $fetchRaw("/opds/", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(data).toContain("<title>New Arrivals</title>");
    expect(data).toContain("<title>All Books</title>");
    expect(data).toContain("<title>Genres</title>");
    expect(data).toContain("/opds/new");
    expect(data).toContain("/opds/books");
    expect(data).toContain("/opds/genres");
  });

  it("includes search link", async () => {
    const { data } = await $fetchRaw("/opds/", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(data).toContain('rel="search"');
    expect(data).toContain("/opds/search");
  });

  it("rejects requests without auth and includes WWW-Authenticate header", async () => {
    const { status, headers } = await $fetchRaw("/opds/");
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("Basic");
  });

  it("rejects wrong credentials", async () => {
    const { status } = await $fetchRaw("/opds/", {
      headers: opdsBasicAuth("wrong", "wrong"),
    });
    expect(status).toBe(401);
  });

  /**
   * Nothing caches anywhere in the auth path, so revocation needs no
   * invalidation step to be felt. "Immediately" is the property worth pinning,
   * and this asserts it directly.
   */
  it("stops serving a revoked credential on the very next request", async () => {
    const { data: issued } = await $fetchRaw("/api/app-passwords", {
      method: "POST",
      body: { name: "reader" },
      headers: session(),
    });

    const readerAuth = {
      authorization: `Basic ${Buffer.from(`reader:${issued.key}`).toString("base64")}`,
    };
    expect((await $fetchRaw("/opds/", { headers: readerAuth, responseType: "text" })).status).toBe(
      200,
    );

    await $fetchRaw(`/api/app-passwords/${issued.id}`, {
      method: "DELETE",
      headers: session(),
    });

    expect((await $fetchRaw("/opds/", { headers: readerAuth, responseType: "text" })).status).toBe(
      401,
    );
  });
});

describe("OPDS: GET /opds/books (book listing)", () => {
  it("returns acquisition feed with organized books only", async () => {
    await seedOpdsBooks();

    const { data, status, headers } = await $fetchRaw("/opds/books", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/atom+xml");

    // Should contain organized books
    expect(data).toContain("<title>The Hobbit</title>");
    expect(data).toContain("<title>Dune</title>");
    // Should NOT contain inbox books
    expect(data).not.toContain("Inbox Book");

    // Should have author elements
    expect(data).toContain("<name>J.R.R. Tolkien</name>");
    expect(data).toContain("<name>Frank Herbert</name>");
  });

  it("includes acquisition links for book files", async () => {
    await seedOpdsBooks();

    const { data } = await $fetchRaw("/opds/books", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    // Books have epub files
    expect(data).toContain("application/epub+zip");
    // Download links should reference /opds/download/
    expect(data).toContain("/opds/download/");
  });

  it("includes pagination elements", async () => {
    await seedOpdsBooks();

    const { data } = await $fetchRaw("/opds/books", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(data).toContain("<opensearch:totalResults>");
    expect(data).toContain("<opensearch:itemsPerPage>");
    expect(data).toContain('rel="self"');
    expect(data).toContain('rel="first"');
  });

  // Note: skipped empty-feed test — defineCachedHandler caches across tests,
  // so previously seeded data leaks into subsequent requests for the same path.
});

describe("OPDS: GET /opds/search", () => {
  it("returns OpenSearch description when no query provided", async () => {
    const { data, status, headers } = await $fetchRaw("/opds/search", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("opensearchdescription+xml");
    expect(data).toContain("<OpenSearchDescription");
    expect(data).toContain("<ShortName>Libris</ShortName>");
    expect(data).toContain("{searchTerms}");
  });

  it("returns search results when query is provided", async () => {
    await seedOpdsBooks();

    const { data, status, headers } = await $fetchRaw("/opds/search?q=Hobbit", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/atom+xml");
    expect(data).toContain("<title>The Hobbit</title>");
    expect(data).not.toContain("<title>Dune</title>");
  });

  it("returns empty results for non-matching query", async () => {
    await seedOpdsBooks();

    const { data, status } = await $fetchRaw("/opds/search?q=nonexistentbook", {
      headers: opdsBasicAuth(),
      responseType: "text",
    });
    expect(status).toBe(200);
    expect(data).toContain("<feed");
    expect(data).not.toContain("<entry>");
  });
});

describe("OPDS: GET /opds/covers/:id", () => {
  it("returns 404 for non-existent book", async () => {
    const { status } = await $fetchRaw("/opds/covers/00000000-0000-0000-0000-000000000000", {
      headers: opdsBasicAuth(),
    });
    expect(status).toBe(404);
  });

  it("returns 404 for book without cover", async () => {
    const { hobbitId } = await seedOpdsBooks();

    // Seeded books have no coverPath, so should 404
    const { status } = await $fetchRaw(`/opds/covers/${hobbitId}`, {
      headers: opdsBasicAuth(),
    });
    expect(status).toBe(404);
  });

  it("returns 404 for non-organized book", async () => {
    const { inboxId } = await seedOpdsBooks();

    const { status } = await $fetchRaw(`/opds/covers/${inboxId}`, {
      headers: opdsBasicAuth(),
    });
    expect(status).toBe(404);
  });
});

describe("OPDS: GET /opds/download/:fileId", () => {
  it("returns 401 without auth", async () => {
    const { status } = await $fetchRaw("/opds/download/00000000-0000-0000-0000-000000000000");
    expect(status).toBe(401);
  });

  it("returns 404 for non-existent file", async () => {
    const { status } = await $fetchRaw("/opds/download/00000000-0000-0000-0000-000000000000", {
      headers: opdsBasicAuth(),
    });
    expect(status).toBe(404);
  });

  it("returns 404 when file record exists but file not on disk", async () => {
    const { files } = await seedOpdsBooks();
    const fileId = files[0].id;

    // File record exists but storagePath points to non-existent file
    const { status } = await $fetchRaw(`/opds/download/${fileId}`, {
      headers: opdsBasicAuth(),
    });
    expect(status).toBe(404);
  });
});

// ── Stats: shape + key aggregations ─────────────────────────────────

describe("GET /api/stats", () => {
  it("returns all expected top-level fields with sensible empty-state defaults", async () => {
    const { data, status } = await $fetchRaw("/api/stats", { headers: auth() });
    expect(status).toBe(200);
    expect(data).toMatchObject({
      booksFinished: { allTime: 0, thisYear: 0, thisMonth: 0 },
      genreDistribution: [],
      streak: { current: 0, longest: 0 },
      avgDaysToFinish: 0,
      pagesHeatmap: { year: expect.any(Number), days: [] },
      readingVelocity: [],
      topAuthors: [],
      libraryGrowth: [],
    });
    // finishedPerMonth is always 12 entries (current year padded by generate_series)
    expect(data.finishedPerMonth).toHaveLength(12);
    for (const m of data.finishedPerMonth) {
      expect(m.count).toBe(0);
      expect(m.month).toMatch(/^\d{4}-\d{2}$/);
    }
    // daysToFinishBuckets is always 6 fixed buckets
    expect(data.daysToFinishBuckets.map((b: { bucket: string }) => b.bucket)).toEqual([
      "0-7",
      "8-14",
      "15-30",
      "31-60",
      "61-90",
      "91+",
    ]);
    for (const b of data.daysToFinishBuckets) expect(b.count).toBe(0);
  });

  it("honours ?year= for the heatmap payload", async () => {
    const { data, status } = await $fetchRaw("/api/stats?year=2020", { headers: auth() });
    expect(status).toBe(200);
    expect(data.pagesHeatmap.year).toBe(2020);
  });

  it("rejects invalid year query param", async () => {
    const { status } = await $fetchRaw("/api/stats?year=notayear", { headers: auth() });
    expect(status).toBe(400);
  });

  it("topAuthors groups organized books by author and sorts desc", async () => {
    await $fetchRaw("/__test/seed-books", {
      method: "POST",
      headers: auth(),
      body: {
        books: [
          { title: "A1", author: "Will Wight", status: "organized" },
          { title: "A2", author: "Will Wight", status: "organized" },
          { title: "A3", author: "Will Wight", status: "organized" },
          { title: "B1", author: "Brandon Sanderson", status: "organized" },
          { title: "B2", author: "Brandon Sanderson", status: "organized" },
          { title: "C1", author: "Terry Pratchett", status: "organized" },
          { title: "X1", author: "Inbox Only", status: "inbox" }, // excluded
        ],
      },
    });
    const { data, status } = await $fetchRaw("/api/stats", { headers: auth() });
    expect(status).toBe(200);
    expect(data.topAuthors).toEqual([
      { author: "Will Wight", count: 3 },
      { author: "Brandon Sanderson", count: 2 },
      { author: "Terry Pratchett", count: 1 },
    ]);
  });

  it("libraryGrowth is strictly non-decreasing (cumulative)", async () => {
    await $fetchRaw("/__test/seed-books", {
      method: "POST",
      headers: auth(),
      body: {
        books: [
          { title: "G1", status: "organized" },
          { title: "G2", status: "organized" },
          { title: "G3", status: "inbox" },
        ],
      },
    });
    const { data, status } = await $fetchRaw("/api/stats", { headers: auth() });
    expect(status).toBe(200);
    expect(data.libraryGrowth.length).toBeGreaterThanOrEqual(1);
    let prev = -1;
    for (const row of data.libraryGrowth) {
      expect(row.cumulative).toBeGreaterThanOrEqual(prev);
      prev = row.cumulative;
    }
    // All 3 books should land in the final cumulative count
    const last = data.libraryGrowth[data.libraryGrowth.length - 1];
    expect(last.cumulative).toBe(3);
  });

  it("counts manual-only finished books (no kosync data) toward all-time and date buckets", async () => {
    await $fetchRaw("/__test/seed-books", {
      method: "POST",
      headers: auth(),
      body: {
        books: [{ title: "Manually Finished", author: "Author M", status: "organized" }],
      },
    });
    const [book] = await testDb
      .select({ id: books.id })
      .from(books)
      .where(eq(books.title, "Manually Finished"));
    expect(book).toBeDefined();

    const finishedAt = new Date();
    const startedAt = new Date(finishedAt.getTime() - 10 * 86400 * 1000);
    await testDb.insert(readingAggregate).values({
      userId,
      bookId: book!.id,
      manualStatus: "finished",
      manualStartedAt: startedAt,
      manualFinishedAt: finishedAt,
      manualSetAt: finishedAt,
    });

    const { data, status } = await $fetchRaw("/api/stats", { headers: auth() });
    expect(status).toBe(200);
    expect(data.booksFinished.allTime).toBe(1);
    expect(data.booksFinished.thisYear).toBe(1);
    expect(data.booksFinished.thisMonth).toBe(1);
    // 10-day span lands in the 8-14 bucket.
    const bucket = data.daysToFinishBuckets.find(
      (b: { bucket: string; count: number }) => b.bucket === "8-14",
    );
    expect(bucket?.count).toBe(1);
    expect(data.avgDaysToFinish).toBe(10);
  });

  it("counts external-only finished books (Hardcover) toward all-time but not date buckets", async () => {
    await $fetchRaw("/__test/seed-books", {
      method: "POST",
      headers: auth(),
      body: {
        books: [
          {
            title: "Hardcover Finished",
            author: "Author H",
            genres: ["Sci-Fi"],
            status: "organized",
          },
        ],
      },
    });
    const [book] = await testDb
      .select({ id: books.id })
      .from(books)
      .where(eq(books.title, "Hardcover Finished"));
    expect(book).toBeDefined();

    await testDb.insert(readingAggregate).values({
      userId,
      bookId: book!.id,
      externalStatus: "finished",
      externalStatusSyncedAt: new Date(),
    });

    const { data, status } = await $fetchRaw("/api/stats", { headers: auth() });
    expect(status).toBe(200);
    // Counted in all-time...
    expect(data.booksFinished.allTime).toBe(1);
    // ...but no known finish date, so excluded from date-bucketed metrics.
    expect(data.booksFinished.thisYear).toBe(0);
    expect(data.booksFinished.thisMonth).toBe(0);
    // Genre distribution still includes it.
    const sciFi = data.genreDistribution.find((g: { genre: string }) => g.genre === "Sci-Fi");
    expect(sciFi?.count).toBe(1);
  });
});
