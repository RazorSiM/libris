/**
 * Integration tests: OPDS feed endpoints.
 *
 * Uses a PGlite in-memory database and the Hono test client (app.request())
 * so no live server or external dependencies are required.
 *
 * Cover image and file download endpoints require real filesystem access
 * and are covered by the E2E suite (tests/e2e/opds.spec.ts).
 */

import { createMemoryKVStore } from "../services/kv-store.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { PGlite } from "@electric-sql/pglite";
import { createApp } from "../app.js";
import { createTestAuth, createTestDb, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const OPDS_USER = "opds-int-test";

/**
 * What an OPDS reader sends: Basic, with the app password in the PASSWORD
 * field. The username is informational — the middleware ignores it — but real
 * readers always send one, so the fixture does too.
 */
function opdsAuthHeader(password = opdsAppPassword): string {
  const encoded = Buffer.from(`${OPDS_USER}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
  BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
  BETTER_AUTH_URL: "",
  COOKIE_DOMAIN: "",
  MIGRATIONS_PATH: "./migrations",
  TRUST_PROXY_HEADERS: "0",
  E2E_TEST: "",
  LOG_LEVEL: "info",
  LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
  LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
};

let pglite: PGlite;
let db: TestDb;
let app: ReturnType<typeof createApp>["app"];
let auth: ReturnType<typeof createTestAuth>;
let opdsAppPassword: string;
let opdsUserId: string;

// IDs set during seeding
let prideBookId: string;

beforeAll(async () => {
  // 1. Create in-memory DB with migrations
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;

  // 2. Create the Hono app with the PGlite DB
  const services = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    queues: {
      bookDetected: { add: async () => ({}) },
      bookParseFile: { add: async () => ({}) },
      bookFetchMetadata: { add: async () => ({}) },
      bookOrganize: { add: async () => ({}) },
      close: async () => {},
    },
    redisStorage: createMemoryKVStore(),
    cacheStorage: createMemoryKVStore(),
    auth: (auth = createTestAuth(db, TEST_ENV)),
    shutdown: async () => {},
  };

  ({ app } = createApp({ services, env: TEST_ENV }));

  // 3. A user and an app password — OPDS credentials are Better Auth api keys
  // now, not rows in service_credentials (libris-5ng.12).
  const created = await auth.api.createUser({
    body: {
      email: "opds-int-test@example.test",
      password: "correct-horse-battery-staple",
      name: "OPDS Reader",
    },
  });
  opdsUserId = created.user.id;
  opdsAppPassword = (
    await auth.api.createApiKey({ body: { userId: opdsUserId, name: "KOReader" } })
  ).key;

  // 4. Seed test books
  const [prideRow] = await db
    .insert(schema.books)
    .values({
      status: "organized",
      createdBy: opdsUserId,
      title: "Pride and Prejudice",
      author: "Jane Austen",
      genres: ["Romance", "Classic"],
      publisher: "T. Egerton",
      language: "en",
    })
    .returning();
  prideBookId = prideRow.id;

  // epub file for Pride — needed for acquisition links
  await db.insert(schema.bookFiles).values({
    bookId: prideBookId,
    format: "epub",
    originalName: "pride.epub",
  });

  // 1984 — no files (used for search exclusion tests)
  await db.insert(schema.books).values({
    status: "organized",
    createdBy: opdsUserId,
    title: "1984",
    author: "George Orwell",
  });
});

afterAll(async () => {
  await pglite.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OPDS Feed (integration)", () => {
  it("OPDS index at /opds returns valid navigation XML", async () => {
    const res = await app.request("/opds", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");
    expect(contentType).toContain("kind=navigation");

    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(xml).toContain("<title>Libris</title>");
    expect(xml).toContain("New Arrivals");
    expect(xml).toContain("All Books");
    expect(xml).toContain('rel="search"');
    expect(xml).toContain("opensearchdescription+xml");
  });

  it("/opds/books returns acquisition feed with book entries", async () => {
    const res = await app.request("/opds/books", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");
    expect(contentType).toContain("kind=acquisition");

    const xml = await res.text();
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).toContain("Jane Austen");
    expect(xml).toContain("1984");
    expect(xml).toContain("George Orwell");

    // Dublin Core metadata
    expect(xml).toContain("<dc:language>en</dc:language>");
    expect(xml).toContain("<dc:publisher>T. Egerton</dc:publisher>");
    expect(xml).toContain('<category term="Romance"/>');
    expect(xml).toContain('<category term="Classic"/>');

    // Acquisition link for the epub file
    expect(xml).toContain("application/epub+zip");
    expect(xml).toContain("/opds/download/");

    // Pagination elements
    expect(xml).toContain("opensearch:totalResults");
    expect(xml).toContain(">2<"); // 2 books total
  });

  it("/opds/search?q=pride returns filtered results", async () => {
    const res = await app.request("/opds/search?q=pride", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("kind=acquisition");

    const xml = await res.text();
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).not.toContain(">1984<");
    expect(xml).toContain("<title>Search: pride</title>");
  });

  it("/opds/search without query returns OpenSearch description", async () => {
    const res = await app.request("/opds/search", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("opensearchdescription+xml");

    const xml = await res.text();
    expect(xml).toContain("OpenSearchDescription");
    expect(xml).toContain("<ShortName>Libris</ShortName>");
    expect(xml).toContain("{searchTerms}");
  });

  it("Basic auth works for e-reader compatibility", async () => {
    const res = await app.request("/opds/books", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/atom+xml");

    const xml = await res.text();
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).toContain("Jane Austen");
  });

  it("unauthenticated request returns 401", async () => {
    const res = await app.request("/opds");
    expect(res.status).toBe(401);
  });

  it("Content-Type headers are correct for each endpoint", async () => {
    const authHeader = opdsAuthHeader();

    const indexRes = await app.request("/opds", {
      headers: { Authorization: authHeader },
    });
    expect(indexRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=navigation",
    );

    const booksRes = await app.request("/opds/books", {
      headers: { Authorization: authHeader },
    });
    expect(booksRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );

    const newRes = await app.request("/opds/new", {
      headers: { Authorization: authHeader },
    });
    expect(newRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );

    const entryRes = await app.request(`/opds/books/${prideBookId}`, {
      headers: { Authorization: authHeader },
    });
    expect(entryRes.headers.get("content-type")).toContain(
      "application/atom+xml;type=entry;profile=opds-catalog",
    );

    const searchDescRes = await app.request("/opds/search", {
      headers: { Authorization: authHeader },
    });
    expect(searchDescRes.headers.get("content-type")).toContain(
      "application/opensearchdescription+xml",
    );

    const searchRes = await app.request("/opds/search?q=test", {
      headers: { Authorization: authHeader },
    });
    expect(searchRes.headers.get("content-type")).toContain(
      "application/atom+xml;profile=opds-catalog;kind=acquisition",
    );
  });

  it("OPDS index includes a Languages navigation entry", async () => {
    const res = await app.request("/opds", {
      headers: { Authorization: opdsAuthHeader() },
    });

    const xml = await res.text();
    expect(xml).toContain("<title>Languages</title>");
    expect(xml).toContain("/opds/languages");
  });

  it("/opds/languages lists only the languages present, as full names", async () => {
    const res = await app.request("/opds/languages", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("kind=navigation");

    const xml = await res.text();
    // English is present (Pride and Prejudice); shown as a full name, not the code.
    expect(xml).toContain("<title>English</title>");
    expect(xml).toContain("/opds/languages/en");
    expect(xml).toContain("1 book");
    // Only languages we actually have — never the full ISO 639-1 list.
    expect(xml).not.toContain("Italian");
    expect(xml).not.toContain("French");
  });

  it("/opds/languages/en returns only books in that language", async () => {
    const res = await app.request("/opds/languages/en", {
      headers: { Authorization: opdsAuthHeader() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("kind=acquisition");

    const xml = await res.text();
    expect(xml).toContain("<title>English</title>"); // feed title
    expect(xml).toContain("Pride and Prejudice");
    expect(xml).not.toContain(">1984<"); // 1984 has no language set
  });
});
