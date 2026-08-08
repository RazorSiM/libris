/**
 * Per-user reading status, over HTTP, on a database the route can run on.
 *
 * `/api/reading-status/counts` had NO integration coverage at all, and could not
 * have had any: `getReadingStatusCounts` iterates `db.execute(...)` directly,
 * which is an array under postgres-js and a `{ rows }` object under PGlite, so
 * the endpoint throws "result is not iterable" in the ordinary test harness.
 * (`/api/stats` avoids this with its own `rowsOf()` normaliser; reading-status
 * has no equivalent.)
 *
 * That is why the isolation this file checks used to be "verified at the data
 * layer" instead — tests that inserted rows and selected them straight back
 * without the route (libris-59m.31). Those could not fail. Running the real app
 * against real PostgreSQL is what makes the assertion mean something.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/client.js";
import { createAuth } from "../src/lib/auth.js";
import * as schema from "../src/db/schema.js";
import { createMemorySecondaryStorage } from "../src/services/auth-secondary-storage.js";
import { createMemoryKVStore } from "../src/services/kv-store.js";
import {
  announceSkip,
  createScratchDatabase,
  isPostgresReachable,
  SERVICES_ARE_REQUIRED,
  TEST_POSTGRES_URL,
  type ScratchDatabase,
} from "./backing-services.js";

const reachable = await isPostgresReachable();

if (!reachable) {
  const why =
    `PostgreSQL at ${TEST_POSTGRES_URL} is unreachable. /api/reading-status/counts CANNOT run ` +
    `on PGlite -- getReadingStatusCounts iterates db.execute(), which PGlite resolves to ` +
    `{ rows }, so the route 500s there. These tests check nothing without a real server. ` +
    `Start one with \`docker compose -f docker-compose.test.yml up -d --wait postgres\`, or ` +
    `point LIBRIS_TEST_POSTGRES_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("reading-status-isolation.postgres.test.ts", why);
}

const TEST_PASSWORD = "correct-horse-battery-staple";

const ENV: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgres://unused",
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
  LIBRIS_RATELIMIT_AUTH_LIMIT: 300,
  LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS: 60,
  LIBRIS_RATELIMIT_KEY_CREATION_LIMIT: 300,
  LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS: 3600,
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 10_000,
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 30_000,
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: 30_000,
};

describe.skipIf(!reachable)("reading status isolation over HTTP", () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let app: ReturnType<typeof createApp>["app"];
  let auth: ReturnType<typeof createAuth>;

  /** md5("testpass-strong") — the userkey KOReader sends after the exchange. */
  const KOSYNC_KEY = "7b41a909c57c86088eb92f47bdd6dc67";
  const KOSYNC_PASSWORD = "testpass-strong";

  let readerId: string;
  let readerCookie: string;
  let otherCookie: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase("readingstatus");
    db = scratch.db;

    auth = createAuth({
      db,
      secondaryStorage: createMemorySecondaryStorage(),
      env: ENV,
      secret: ENV.BETTER_AUTH_SECRET,
      baseURL: "http://localhost:3000",
    });

    app = createApp({
      services: {
        db,
        queues: {
          bookDetected: { add: async () => ({}) },
          bookParseFile: { add: async () => ({}) },
          bookFetchMetadata: { add: async () => ({}) },
          bookOrganize: { add: async () => ({}) },
          close: async () => {},
        } as never,
        redisStorage: createMemoryKVStore(),
        cacheStorage: createMemoryKVStore(),
        auth,
        shutdown: async () => {},
      },
      env: ENV,
    }).app;
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  beforeAll(async () => {
    readerId = await createPerson("reader@example.test", "admin");
    await createPerson("other@example.test", "user");
    readerCookie = await signIn("reader@example.test");
    otherCookie = await signIn("other@example.test");

    await putCredential(readerCookie, "reader-kosync");
    await putCredential(otherCookie, "other-kosync");
  }, 60_000);

  afterEach(async () => {
    await db.delete(schema.readingProgressHistory);
    await db.delete(schema.readingProgress);
    await db.delete(schema.readingAggregate);
    await db.delete(schema.bookFiles);
    await db.delete(schema.books);
  });

  async function createPerson(email: string, role: "user" | "admin"): Promise<string> {
    const created = await auth.api.createUser({
      body: { email, password: TEST_PASSWORD, name: email.split("@")[0]!, role },
    });
    return created.user.id;
  }

  async function signIn(email: string): Promise<string> {
    const { headers } = await auth.api.signInEmail({
      body: { email, password: TEST_PASSWORD },
      returnHeaders: true,
    });
    return headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  async function putCredential(cookie: string, username: string) {
    const res = await app.request("http://localhost/api/credentials/kosync", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ username, password: KOSYNC_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`kosync credential PUT failed: ${res.status}`);
  }

  /** An organized book with a file, so a KoSync document resolves to it. */
  async function seedBook(title: string): Promise<string> {
    const [book] = await db
      .insert(schema.books)
      .values({ title, author: title, status: "organized", createdBy: readerId })
      .returning({ id: schema.books.id });
    await db.insert(schema.bookFiles).values({
      bookId: book!.id,
      format: "epub",
      originalName: `${title}.epub`,
      storagePath: `/tmp/${title}.epub`,
      contentHash: `hash-${title}`,
    });
    return book!.id;
  }

  async function sync(username: string, title: string, percentage: number) {
    const res = await app.request("http://localhost/kosync/syncs/progress", {
      method: "PUT",
      headers: {
        "x-auth-user": username,
        "x-auth-key": KOSYNC_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        document: `hash-${title}`,
        progress: "/ch[1]",
        device: "kindle",
        percentage,
      }),
    });
    if (res.status !== 200) throw new Error(`kosync sync failed: ${res.status}`);
  }

  async function counts(cookie: string) {
    const res = await app.request("http://localhost/api/reading-status/counts", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, number>;
  }

  async function listByStatus(cookie: string, status: string) {
    const res = await app.request(`http://localhost/api/reading-status/${status}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: { title: string }[] };
  }

  it("counts a book as finished for the person who finished it and unread for everyone else", async () => {
    await seedBook("shared");

    await sync("reader-kosync", "shared", 0.99);

    expect(await counts(readerCookie)).toMatchObject({ finished: 1, unread: 0 });
    // Same book, same library, different person: they have not read it.
    expect(await counts(otherCookie)).toMatchObject({ finished: 0, unread: 1 });
  });

  it("keeps two readers at different statuses on the same book", async () => {
    await seedBook("shared");

    await sync("reader-kosync", "shared", 0.99);
    await sync("other-kosync", "shared", 0.4);

    expect(await counts(readerCookie)).toMatchObject({ finished: 1, reading: 0 });
    expect(await counts(otherCookie)).toMatchObject({ finished: 0, reading: 1 });
  });

  it("lists a book under a status only for the reader who is at it", async () => {
    await seedBook("mine");
    await seedBook("theirs");

    await sync("reader-kosync", "mine", 0.99);
    await sync("other-kosync", "theirs", 0.99);

    expect((await listByStatus(readerCookie, "finished")).data.map((b) => b.title)).toEqual([
      "mine",
    ]);
    expect((await listByStatus(otherCookie, "finished")).data.map((b) => b.title)).toEqual([
      "theirs",
    ]);
  });

  it("totals every organized book for each reader independently", async () => {
    await seedBook("a");
    await seedBook("b");
    await seedBook("c");

    await sync("reader-kosync", "a", 0.99);
    await sync("reader-kosync", "b", 0.5);

    const reader = await counts(readerCookie);
    expect(reader.finished + reader.reading + reader.paused + reader.unread).toBe(3);
    expect(reader).toMatchObject({ finished: 1, unread: 1 });

    const other = await counts(otherCookie);
    expect(other).toMatchObject({ finished: 0, reading: 0, paused: 0, unread: 3 });
  });
});
