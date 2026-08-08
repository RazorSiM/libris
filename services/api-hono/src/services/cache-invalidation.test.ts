/**
 * The two halves of the route cache have to name the same paths.
 *
 * `cachedRoute` was mounted only on `/opds/*` and `/api/stats`, while every
 * `invalidateRouteCache` call named `/api/library`, `/api/inbox`,
 * `/api/settings` or `/api/books/{id}/candidates`. Both lists read as
 * plausible; neither shared a single key with the other. So approving, editing
 * or deleting a book cleared nothing, and an e-reader refreshing its catalogue
 * kept the pre-mutation feed until the entry's 60-120s TTL expired.
 *
 * These tests pin the pairing itself rather than the strings on either side:
 * one exercises a real mutation against a real cached feed, and two derive the
 * mounted-and-invalidated sets from the assembled router and the route sources
 * so a future divergence fails here instead of becoming a stale feed.
 */
import { createNodeWebSocket } from "@hono/node-ws";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "../app.js";
import { createTestAuth, createTestDb, seedAppPassword, type TestDb } from "../db/test-utils.js";
import * as schema from "../db/schema.js";
import type { Env } from "../env.js";
import { isCachedRouteHandler } from "../middleware/cache.js";
import { hashKosyncSecret } from "../shared/kosync-auth.js";
import { md5 } from "../shared/auth.js";
import { createRouter } from "../routes/index.js";
import { CACHED_ROUTE_PREFIXES, isCachedRoutePrefix } from "./cache.js";
import { createMemoryKVStore, type KVStore } from "./kv-store.js";

const TEST_ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
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

// ---------------------------------------------------------------------------
// The pairing, exercised end to end
// ---------------------------------------------------------------------------

describe("a book mutation clears the OPDS feed it changed", () => {
  let pglite: PGlite;
  let db: TestDb;
  let app: ReturnType<typeof createApp>["app"];
  let cacheStorage: KVStore;
  let userId: string;
  let auth: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    pglite = testDb.pglite;
    db = testDb.db;
    cacheStorage = createMemoryKVStore();

    const authInstance = createTestAuth(db, TEST_ENV);
    const seeded = await seedAppPassword(authInstance, db, { name: "OPDS Cache Test" });
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
      env: TEST_ENV,
    }));
  });

  afterAll(async () => {
    await pglite.close();
  });

  async function seedOrganizedBook(title: string): Promise<string> {
    const [book] = await db
      .insert(schema.books)
      .values({ status: "organized", title, author: "A. Author", createdBy: userId })
      .returning({ id: schema.books.id });
    // Seeding writes straight to Postgres, which is outside the invalidation
    // contract entirely — no route ran. Start each case from a cold cache so
    // what it observes afterwards is the mutation's doing and nothing else.
    await cacheStorage.clear();
    return book.id;
  }

  async function feed(path: string): Promise<{ xml: string; cache: string | null }> {
    const res = await app.request(path, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    return { xml: await res.text(), cache: res.headers.get("x-cache") };
  }

  it("PATCH /api/library/{id} evicts the cached /opds/books entry", async () => {
    const bookId = await seedOrganizedBook("Stale Title");

    // Warm the cache the way a reader does, and prove it is warm.
    expect((await feed("/opds/books")).cache).toBe("MISS");
    const warm = await feed("/opds/books");
    expect(warm.cache).toBe("HIT");
    expect(warm.xml).toContain("Stale Title");

    const patch = await app.request(`/api/library/${bookId}`, {
      method: "PATCH",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh Title" }),
    });
    expect(patch.status).toBe(200);

    // Pre-fix this was still a HIT carrying "Stale Title": the handler
    // invalidated "/api/library", and no key under that prefix has ever
    // existed, so the /opds entry survived until its TTL.
    const after = await feed("/opds/books");
    expect(after.cache).toBe("MISS");
    expect(after.xml).toContain("Fresh Title");
    expect(after.xml).not.toContain("Stale Title");
  });

  it("DELETE /api/books/{id} evicts every cached feed the book appeared in", async () => {
    const bookId = await seedOrganizedBook("Doomed Book");

    // Two different cached feeds, so the test also pins that invalidation is by
    // prefix rather than by the one URL the mutation happens to know about.
    expect((await feed("/opds/books")).xml).toContain("Doomed Book");
    expect((await feed("/opds/new")).xml).toContain("Doomed Book");
    expect((await feed("/opds/books")).cache).toBe("HIT");
    expect((await feed("/opds/new")).cache).toBe("HIT");

    const del = await app.request(`/api/books/${bookId}`, {
      method: "DELETE",
      headers: { Authorization: auth },
    });
    expect(del.status).toBe(204);

    const books = await feed("/opds/books");
    expect(books.cache).toBe("MISS");
    expect(books.xml).not.toContain("Doomed Book");

    const arrivals = await feed("/opds/new");
    expect(arrivals.cache).toBe("MISS");
    expect(arrivals.xml).not.toContain("Doomed Book");
  });

  it("PATCH /api/library/{id}/reading-status evicts the cached /api/stats entry", async () => {
    const bookId = await seedOrganizedBook("Counted Book");

    const stats = async () => {
      const res = await app.request("/api/stats", { headers: { Authorization: auth } });
      expect(res.status).toBe(200);
      return { body: await res.json(), cache: res.headers.get("x-cache") };
    };

    expect((await stats()).cache).toBe("MISS");
    const warm = await stats();
    expect(warm.cache).toBe("HIT");
    const before = warm.body.booksFinished.allTime;

    const patch = await app.request(`/api/library/${bookId}/reading-status`, {
      method: "PATCH",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ status: "finished" }),
    });
    expect(patch.status).toBe(200);

    // Pre-fix the handler invalidated "/api/library" and "/api/reading-status",
    // neither of which is cached, so the finished count stayed stale.
    const after = await stats();
    expect(after.cache).toBe("MISS");
    expect(after.body.booksFinished.allTime).toBe(before + 1);
  });

  it("PUT /kosync/syncs/progress evicts the cached /api/stats it feeds", async () => {
    // The one write path with no UI behind it. Every number the
    // stats page renders comes from the rows this handler writes, and it
    // invalidated nothing — so finishing a book on an e-reader left the counts
    // as they were until the entry's 60s TTL ran out.
    //
    // The invalidation is chained behind the two fire-and-forget writes it
    // follows, so the assertion has to let those settle first; firing it inline
    // would clear the entry and let the next request re-cache the pre-write
    // answer, which is the bug in a different costume.
    const bookId = await seedOrganizedBook("Synced Book");
    const document = "d41d8cd98f00b204e9800998ecf8427e";
    await db
      .insert(schema.bookFiles)
      .values({ bookId, format: "epub", originalName: "s.epub", contentHash: document });

    const password = "kosync-test-password";
    await db.insert(schema.kosyncCredentials).values({
      userId,
      username: "reader",
      secretHash: hashKosyncSecret(md5(password), TEST_ENV.API_SECRET_KEY),
    });

    const stats = async () => {
      const res = await app.request("/api/stats", { headers: { Authorization: auth } });
      expect(res.status).toBe(200);
      return res.headers.get("x-cache");
    };

    expect(await stats()).toBe("MISS");
    expect(await stats()).toBe("HIT");

    const push = await app.request("/kosync/syncs/progress", {
      method: "PUT",
      headers: {
        "x-auth-user": "reader",
        "x-auth-key": md5(password),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document,
        progress: "/body/DocFragment[3]",
        device: "kindle",
        percentage: 0.99,
      }),
    });
    expect(push.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await stats()).toBe("MISS");
    });
  });
});

// ---------------------------------------------------------------------------
// The trap: the two lists drifting apart again
// ---------------------------------------------------------------------------

/** Every path the assembled router mounts a `cachedRoute` middleware on. */
function mountedCachedPaths(): string[] {
  const { upgradeWebSocket } = createNodeWebSocket({ app: new OpenAPIHono() });
  const router = createRouter(upgradeWebSocket);
  const paths = router.routes
    .filter(({ handler }) => isCachedRouteHandler(handler))
    .map(({ path }) => path);
  return [...new Set(paths)].sort();
}

describe("CACHED_ROUTE_PREFIXES matches the real mounts", () => {
  it("finds the mounts at all (guards the marker itself)", () => {
    // If this ever drops to zero the two tests below pass vacuously, which is
    // exactly the shape of failure this pairing exists to catch.
    expect(mountedCachedPaths().length).toBeGreaterThan(5);
  });

  it("covers every mounted cached route", () => {
    const uncovered = mountedCachedPaths().filter((path) => !isCachedRoutePrefix(path));

    // A cached route outside every declared prefix is a feed nothing can ever
    // invalidate.
    expect(uncovered).toEqual([]);
  });

  it("declares no prefix that nothing mounts", () => {
    const mounts = mountedCachedPaths();
    const empty = CACHED_ROUTE_PREFIXES.filter(
      (prefix) => !mounts.some((path) => path === prefix || path.startsWith(`${prefix}/`)),
    );

    // A declared prefix with no mount behind it is the other half of the same
    // bug: an invalidation that reads as coverage and clears nothing.
    expect(empty).toEqual([]);
  });
});

describe("every invalidateRouteCache call names a cached prefix", () => {
  // Workers as well as routes: a worker's writes land after the request that
  // triggered them returned, and they invalidate through the process-wide store
  // rather than through `c`. A dead prefix there is exactly as invisible as a
  // dead prefix in a handler.
  const scannedDirs = ["../routes/", "../workers/"].map((dir) =>
    fileURLToPath(new URL(dir, import.meta.url)),
  );

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }
    return files;
  }

  it("passes only prefixes that can match a cached key", async () => {
    const files = (await Promise.all(scannedDirs.map(sourceFiles))).flat();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    let callsSeen = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const call of source.matchAll(/invalidateRouteCache\(([^)]*)\)/g)) {
        callsSeen += 1;
        // Argument list minus the leading cacheStorage: string and template
        // literals only, which is all any call site uses.
        for (const literal of call[1].matchAll(/["'`]([^"'`]*)["'`]/g)) {
          const prefix = literal[1];
          if (!isCachedRoutePrefix(prefix)) offenders.push(`${file}: ${prefix}`);
        }
      }
    }

    // The TypeScript signature already rejects these, but only for literals it
    // can see; this is the belt to that braces, and it names the file.
    expect(offenders).toEqual([]);
    // ...and it must actually have found calls to check.
    expect(callsSeen).toBeGreaterThan(0);
  });
});
