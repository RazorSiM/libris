/**
 * `normalized` reaches the client as an OBJECT, on the driver production uses.
 *
 * The whole metadata review page hangs off this. `MetadataFieldPicker` reads
 * `candidate.normalized[fieldKey]`, so a `normalized` that arrives as a JSON
 * *string* renders every field as "No metadata found — enter manually" and
 * leaves Approve disabled at `Approve (0)` — with no error anywhere, because
 * the candidate count still reads 2.
 *
 * It is not covered by the PGlite suite, and cannot be: jsonb decoding is the
 * driver's job, and PGlite and postgres-js are different drivers with different
 * codec paths. Two things it pins that a version bump can silently move:
 *
 *  1. A jsonb object written through Drizzle round-trips as an object. Under
 *     drizzle-orm 1.0.0-beta this went through `PgJsonb.mapToDriverValue` /
 *     `mapFromDriverValue`; under 1.0.0-rc those are gone and the postgres-js
 *     codec table does the work. Both are meant to be transparent.
 *
 *  2. A jsonb *string* is NOT silently rehydrated into an object. beta's
 *     `mapFromDriverValue` JSON.parse'd any string it was handed, which
 *     repaired malformed rows on read — and hid, for the whole life of that
 *     dependency, that the E2E seed helpers were writing
 *     `${JSON.stringify(obj)}::jsonb` and therefore storing jsonb strings.
 *     The rc dropped the leniency and three E2E specs went red at once. Pinning
 *     the strict behaviour means a future bump that reintroduces the coercion
 *     is a visible decision rather than another silent mask.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { createAuth } from "../src/lib/auth.js";
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
    `PostgreSQL at ${TEST_POSTGRES_URL} is unreachable. jsonb decoding is the DRIVER's job, so ` +
    `running this against PGlite would check a code path production never takes. Start a server ` +
    `with \`docker compose -f docker-compose.test.yml up -d --wait postgres\`, or point ` +
    `LIBRIS_TEST_POSTGRES_URL at your own.`;
  if (SERVICES_ARE_REQUIRED) {
    throw new Error(`${why} CI is set, so this is a failure rather than a skip.`);
  }
  announceSkip("jsonb-metadata.postgres.test.ts", why);
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

interface DetailBody {
  candidates: Array<{ source: string; normalized: unknown }>;
}

describe.skipIf(!reachable)("metadata candidates over postgres-js", () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let app: ReturnType<typeof createApp>["app"];
  let ownerId: string;
  let cookie: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase("jsonbmeta");
    db = scratch.db;

    const auth = createAuth({
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

    const created = await auth.api.createUser({
      body: {
        email: "owner@example.test",
        password: TEST_PASSWORD,
        name: "Owner",
        role: "admin",
      },
    });
    ownerId = created.user.id;

    const { headers } = await auth.api.signInEmail({
      body: { email: "owner@example.test", password: TEST_PASSWORD },
      returnHeaders: true,
    });
    cookie = headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }, 60_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  async function seedReviewBook(title: string): Promise<string> {
    const [book] = await db
      .insert(schema.books)
      .values({ title, author: "Author", status: "review", createdBy: ownerId })
      .returning({ id: schema.books.id });
    await db.insert(schema.bookFiles).values({
      bookId: book!.id,
      format: "epub",
      originalName: `${title}.epub`,
      contentHash: `hash-${title}`,
    });
    return book!.id;
  }

  async function getDetail(bookId: string): Promise<DetailBody> {
    const res = await app.request(`http://localhost/api/inbox/${bookId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as DetailBody;
  }

  it("emits a jsonb object as an object the picker can index", async () => {
    const bookId = await seedReviewBook("Round Trip");
    await db.insert(schema.bookMetadataCandidates).values([
      {
        bookId,
        source: "file",
        confidence: "0.5",
        normalized: { title: "Round Trip", author: "Author" },
      },
      {
        bookId,
        source: "hardcover",
        confidence: "0.9",
        normalized: {
          title: "Round Trip",
          author: "Author",
          publisher: "Test Publisher",
          genres: ["Testing"],
        },
      },
    ]);

    const body = await getDetail(bookId);
    const byField = body.candidates.find((c) => c.source === "file")!;
    const byHardcover = body.candidates.find((c) => c.source === "hardcover")!;

    // `typeof "…" === "string"` is the whole failure: the picker asks for
    // `normalized[fieldKey]` and a string answers `undefined` for every key.
    expect(typeof byField.normalized).toBe("object");
    expect(byField.normalized).toEqual({ title: "Round Trip", author: "Author" });
    expect(typeof byHardcover.normalized).toBe("object");
    expect(byHardcover.normalized).toMatchObject({
      publisher: "Test Publisher",
      genres: ["Testing"],
    });

    // And the column really is a jsonb object, not a jsonb string that the read
    // path happens to repair.
    const [stored] = await db.execute<{ t: string }>(
      sql`select jsonb_typeof(normalized) as t from book_metadata_candidates
          where book_id = ${bookId} and source = 'file'`,
    );
    expect(stored!.t).toBe("object");
  }, 60_000);

  it("does not silently rehydrate a jsonb string into an object", async () => {
    // What `${JSON.stringify(obj)}::jsonb` stores through postgres-js: the
    // driver serialises a jsonb parameter with JSON.stringify, so an
    // already-encoded string is encoded twice and lands as a jsonb string.
    const bookId = await seedReviewBook("Double Encoded");
    await db.execute(
      sql`insert into book_metadata_candidates (book_id, source, confidence, normalized)
          values (${bookId}, 'file', 0.5,
                  to_jsonb(${JSON.stringify({ title: "Double Encoded" })}::text))`,
    );

    const [stored] = await db.execute<{ t: string }>(
      sql`select jsonb_typeof(normalized) as t from book_metadata_candidates
          where book_id = ${bookId}`,
    );
    expect(stored!.t).toBe("string");

    const body = await getDetail(bookId);
    // Garbage in, garbage out — deliberately. The value the API hands back is
    // the value in the column. If this ever starts coming back as an object,
    // some layer has resumed guessing, and malformed rows are being hidden
    // again rather than surfaced.
    expect(typeof body.candidates[0]!.normalized).toBe("string");
  }, 60_000);
});
