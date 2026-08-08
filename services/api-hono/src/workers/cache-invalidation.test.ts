/**
 * Workers have to invalidate the route cache too.
 *
 * The first pass paired the mutating HTTP routes with the surfaces that are
 * actually cached, and left the background half uncovered — which is where the
 * gap is most visible. `POST /api/books/{id}/approve` sets the status,
 * invalidates and returns; `book-organize` then runs for as long as the file
 * takes to move and writes `coverPath` and `storagePath` afterwards. Nothing
 * invalidated at that point, and `bookToEntry` decides an entry's cover link on
 * `coverPath`, so an e-reader refreshing its catalogue right after an approval
 * got the book with no cover and kept getting it for the entry's 60-120s TTL.
 *
 * These run the real worker against a real cached feed rather than asserting
 * that some function was called: the pre-fix failure is a HIT, and only a
 * request can see one.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../app.js";
import * as schema from "../db/schema.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../db/test-utils.js";
import { __setTestEnv, type Env } from "../env.js";
import { buildZip } from "../lib/epub/zip.js";
import { setCacheStorage } from "../services/cache-storage.js";
import { __setTestDb } from "../services/db.js";
import { createMemoryKVStore, type KVStore } from "../services/kv-store.js";
import { processBookFetchMetadata } from "./book-fetch-metadata.js";
import { processBookOrganize } from "./book-organize.js";

// Only the network half of the metadata module is faked. `extractEpubCoverImage`
// comes from the same barrel and is the real thing here on purpose: it is what
// gives the organize job a `coverPath` to write.
const { searchHardcover, getHardcoverTokenForUser } = vi.hoisted(() => ({
  searchHardcover: vi.fn(),
  getHardcoverTokenForUser: vi.fn(async () => null),
}));

vi.mock("../lib/metadata/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/metadata/index.js")>()),
  searchHardcover,
  getHardcoverTokenForUser,
}));

let inboxPath: string;
let libraryPath: string;
let pglite: PGlite;
let db: TestDb;
let app: ReturnType<typeof createApp>["app"];
let cacheStorage: KVStore;
let userId: string;
let auth: string;

function testEnv(): Env {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "pglite://",
    REDIS_URL: "redis://localhost:6379",
    LIBRIS_INBOX_PATH: inboxPath,
    LIBRIS_LIBRARY_PATH: libraryPath,
    LIBRIS_COVER_FETCH_ALLOWLIST: [],
    API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
    BETTER_AUTH_SECRET: "test-better-auth-secret-at-least-32-chars!!",
    BETTER_AUTH_URL: "",
    LIBRIS_COOKIE_SECURE: "0",
    MIGRATIONS_PATH: "./migrations",
    TRUST_PROXY_HEADERS: "0",
    LIBRIS_TRUSTED_PROXIES: [],
    E2E_TEST: "",
    LOG_LEVEL: "info",
    LIBRIS_RATELIMIT_GENERAL_LIMIT: 600,
    LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_AUTH_LIMIT: 30,
    LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
    LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 30,
    LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
    LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
    LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
    LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
  };
}

/** A minimal but genuine EPUB whose OPF points at a cover image. */
function epubWithCover(): Buffer {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Cover Bearer</dc:title>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
</package>`;
  const container = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  return buildZip([
    { name: "mimetype", data: Buffer.from("application/epub+zip") },
    { name: "META-INF/container.xml", data: Buffer.from(container) },
    { name: "OEBPS/content.opf", data: Buffer.from(opf) },
    { name: "OEBPS/images/cover.jpg", data: Buffer.from("FAKE-JPEG-DATA") },
  ]);
}

beforeAll(async () => {
  inboxPath = await mkdtemp(join(tmpdir(), "libris-worker-cache-inbox-"));
  libraryPath = await mkdtemp(join(tmpdir(), "libris-worker-cache-library-"));
  __setTestEnv(testEnv());

  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
  // The worker resolves its own db and cache store — it has no request to take
  // them from. Pointing both at the same instances the app uses is exactly what
  // bootstrap() does in production.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setTestDb(db as any);
  cacheStorage = createMemoryKVStore();
  setCacheStorage(cacheStorage);

  const authInstance = createTestAuth(db, testEnv());
  const seeded = await seedAppPassword(authInstance, db, { name: "Worker Cache Test" });
  userId = seeded.userId;
  auth = `Bearer ${seeded.rawKey}`;

  ({ app } = createApp({
    services: {
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
      cacheStorage,
      auth: authInstance,
      shutdown: async () => {},
    },
    env: testEnv(),
  }));
});

afterAll(async () => {
  setCacheStorage(undefined);
  await pglite.close();
  await Promise.all([
    rm(inboxPath, { recursive: true, force: true }),
    rm(libraryPath, { recursive: true, force: true }),
  ]);
});

function job(data: Record<string, unknown>) {
  return { data, log: vi.fn().mockResolvedValue(undefined) } as never;
}

async function feed(path: string): Promise<{ xml: string; cache: string | null }> {
  const res = await app.request(path, { headers: { Authorization: auth } });
  expect(res.status).toBe(200);
  return { xml: await res.text(), cache: res.headers.get("x-cache") };
}

/**
 * A book exactly as `POST /{id}/approve` leaves it: already `organized`, so
 * already in the catalogue, with the file still sitting in the inbox and no
 * `coverPath` — the organize job has not run yet.
 */
async function seedApprovedBook(title: string): Promise<string> {
  const [book] = await db
    .insert(schema.books)
    .values({ status: "organized", title, author: "A. Author", createdBy: userId })
    .returning({ id: schema.books.id });

  const file = join(inboxPath, `${title.replace(/\s+/g, "-")}.epub`);
  await writeFile(file, epubWithCover());
  await db.insert(schema.bookFiles).values({
    bookId: book.id,
    format: "epub",
    originalName: `${title}.epub`,
    inboxPath: file,
    fileSize: 1024,
  });

  // Seeding writes straight to Postgres, outside the invalidation contract
  // entirely. Start from a cold cache so what the test observes afterwards is
  // the worker's doing and nothing else.
  await cacheStorage.clear();
  return book.id;
}

describe("book-organize invalidates the feeds it changes", () => {
  it("evicts the cached /opds entry it just gave a cover to", async () => {
    const bookId = await seedApprovedBook("Cover Bearer");

    // Warm the cache the way an e-reader does, and prove it is warm AND that
    // the entry it holds has no cover — which is the whole complaint.
    expect((await feed("/opds/books")).cache).toBe("MISS");
    const warm = await feed("/opds/books");
    expect(warm.cache).toBe("HIT");
    expect(warm.xml).toContain("Cover Bearer");
    expect(warm.xml).not.toContain(`/opds/covers/${bookId}`);

    await processBookOrganize(job({ bookId }));

    // The worker really did write the thing the entry renders...
    const [organized] = await db
      .select({ coverPath: schema.books.coverPath })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));
    expect(organized.coverPath).not.toBeNull();

    // ...and the feed reflects it. Pre-fix both of these failed: the entry was
    // still a HIT, still without its cover link, until the TTL expired.
    const after = await feed("/opds/books");
    expect(after.cache).toBe("MISS");
    expect(after.xml).toContain(`/opds/covers/${bookId}`);
  });

  it("evicts every cached feed the book appears in, not just the one URL", async () => {
    const bookId = await seedApprovedBook("Arrival Notice");

    expect((await feed("/opds/new")).xml).toContain("Arrival Notice");
    expect((await feed("/opds/new")).cache).toBe("HIT");
    expect((await feed("/opds/books")).cache).toBe("MISS");
    expect((await feed("/opds/books")).cache).toBe("HIT");

    await processBookOrganize(job({ bookId }));

    // Invalidation is by prefix, so a worker that has no idea which feeds a
    // book was listed in still clears all of them.
    expect((await feed("/opds/new")).cache).toBe("MISS");
    expect((await feed("/opds/books")).cache).toBe("MISS");
  });

  it("evicts the cached /api/stats the organized book now counts towards", async () => {
    const bookId = await seedApprovedBook("Counted Elsewhere");

    const stats = async () => {
      const res = await app.request("/api/stats", { headers: { Authorization: auth } });
      expect(res.status).toBe(200);
      return res.headers.get("x-cache");
    };

    expect(await stats()).toBe("MISS");
    expect(await stats()).toBe("HIT");

    await processBookOrganize(job({ bookId }));

    // Its author joins topAuthors and its row joins libraryGrowth.
    expect(await stats()).toBe("MISS");
  });

  it("does not fail the job when the cache store is unreachable", async () => {
    // `invalidateRouteCache`'s never-rejects contract, restated at the new
    // call site: the durable writes have already committed by the time the
    // invalidation runs, so a Redis blip must not fail — and retry — a job that
    // moved files on disk.
    const bookId = await seedApprovedBook("Store Down");
    const broken: KVStore = {
      ...cacheStorage,
      getKeys: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    setCacheStorage(broken);

    try {
      await expect(processBookOrganize(job({ bookId }))).resolves.toBeUndefined();
    } finally {
      setCacheStorage(cacheStorage);
    }

    const [organized] = await db
      .select({ status: schema.books.status })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));
    expect(organized.status).toBe("organized");
  });
});

describe("book-fetch-metadata invalidates only when it can be seen", () => {
  it("evicts the cached /opds entry when refreshing an organized book", async () => {
    // The "refresh metadata" path (skipStatusChange) runs against a book that
    // is already in the catalogue and bumps its updatedAt, which IS the entry's
    // <updated> element. Nothing invalidated afterwards.
    const bookId = await seedApprovedBook("Refreshed Book");
    searchHardcover.mockResolvedValue([
      {
        source: "hardcover",
        rawResponse: { id: 1 },
        normalized: { title: "Refreshed Book", author: "A. Author" },
        confidence: 0.9,
      },
    ]);

    expect((await feed("/opds/books")).cache).toBe("MISS");
    expect((await feed("/opds/books")).cache).toBe("HIT");

    await processBookFetchMetadata(
      job({ bookId, searchQuery: "Refreshed Book", skipStatusChange: true }),
    );

    expect((await feed("/opds/books")).cache).toBe("MISS");
  });

  it("leaves the cache alone for a book no cached surface renders", async () => {
    // The ordinary path: a book in "inbox" heading for "review". Neither status
    // appears in any feed, so invalidating would be a SCAN per book on a bulk
    // import that could not clear anything real — the same route/cache
    // mismatch, from the other direction.
    const [book] = await db
      .insert(schema.books)
      .values({ status: "inbox", title: "Not Yet", author: "A. Author", createdBy: userId })
      .returning({ id: schema.books.id });
    await db.insert(schema.bookMetadataCandidates).values({
      bookId: book.id,
      source: "file",
      rawResponse: null,
      normalized: { title: "Not Yet", author: "A. Author" },
      confidence: "1.00",
    });
    searchHardcover.mockResolvedValue([
      {
        source: "hardcover",
        rawResponse: { id: 2 },
        normalized: { title: "Not Yet", author: "A. Author" },
        confidence: 0.9,
      },
    ]);

    await cacheStorage.clear();
    expect((await feed("/opds/books")).cache).toBe("MISS");
    expect((await feed("/opds/books")).cache).toBe("HIT");

    await processBookFetchMetadata(job({ bookId: book.id, searchQuery: "Not Yet" }));

    expect((await feed("/opds/books")).cache).toBe("HIT");
  });
});

describe("the worker-side cache store", () => {
  it("is the same store the request path reads", async () => {
    // The invalidation only means anything if both halves address one
    // keyspace. In-process that is one object; in production it is one Redis
    // prefix. A worker writing to a second memory Map would pass every
    // assertion about "was invalidate called" and clear nothing.
    await mkdir(libraryPath, { recursive: true });
    await feed("/opds/books");
    const warmedKeys = await cacheStorage.getKeys("routes:/opds");

    expect(warmedKeys.length).toBeGreaterThan(0);
  });
});
