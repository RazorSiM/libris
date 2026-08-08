/**
 * `/api/reading-status/*` over HTTP, on the ordinary PGlite harness.
 *
 * This suite could not exist before the driver-shape fix:
 * `getReadingStatusCounts` iterated the result of `db.execute()` directly,
 * which postgres-js returns as an array-like and PGlite resolves to a
 * `{ rows }` object — so the endpoint threw "result is not iterable" here and
 * nowhere else. That single line is the whole reason the endpoint had no
 * integration coverage, and why its per-user isolation had to be verified
 * against a real server
 * (`reading-status-isolation.postgres.test.ts`) or not at all.
 *
 * With `rowsOf()` from `#db/rows` in place, the route answers on both drivers,
 * so the isolation assertions live here — running on every `vp run test`,
 * whether or not a PostgreSQL server happens to be up.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { bootstrapAdmin, createAccount, createFetchHelper, createTestApp } from "./setup.js";
import type { AppServices } from "../src/bootstrap.js";

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let services: AppServices;

let adminCookie: string;
let userCookie: string;

/** md5("testpass-strong") — the userkey KOReader sends once it has exchanged. */
const KOSYNC_KEY = "7b41a909c57c86088eb92f47bdd6dc67";
const KOSYNC_PASSWORD = "testpass-strong";

function kosyncAuth(username: string) {
  return { "x-auth-user": username, "x-auth-key": KOSYNC_KEY };
}

/** Give a person a KoSync username so their reader can sync progress as them. */
async function seedKosyncFor(cookie: string, username: string) {
  const { status } = await $fetchRaw("/api/credentials/kosync", {
    method: "PUT",
    headers: { cookie },
    body: { username, password: KOSYNC_PASSWORD },
  });
  expect(status).toBe(200);
}

/** Organized books with a file each, so a KoSync document resolves to them. */
async function seedBooks(titles: string[]): Promise<void> {
  const { data } = await $fetchRaw("/__test/seed-books", {
    method: "POST",
    body: { books: titles.map((title) => ({ title, author: title, status: "organized" })) },
  });
  const ids: string[] = data.inserted.map((b: { id: string }) => b.id);

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
}

/** Progress arrives the way it really does: over KoSync, as the person reading. */
async function sync(username: string, title: string, percentage: number) {
  const { status } = await $fetchRaw("/kosync/syncs/progress", {
    method: "PUT",
    headers: kosyncAuth(username),
    body: { document: `hash-${title}`, progress: "/ch[1]", device: "kindle", percentage },
  });
  expect(status).toBe(200);
}

async function counts(cookie: string): Promise<Record<string, number>> {
  const { data, status } = await $fetchRaw("/api/reading-status/counts", { headers: { cookie } });
  expect(status).toBe(200);
  return data as Record<string, number>;
}

async function listByStatus(cookie: string, status: string): Promise<string[]> {
  const { data, status: httpStatus } = await $fetchRaw(`/api/reading-status/${status}`, {
    headers: { cookie },
  });
  expect(httpStatus).toBe(200);
  return (data.data as { title: string }[]).map((b) => b.title);
}

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  services = testApp.services;
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });

  adminCookie = (await bootstrapAdmin(services, $fetchRaw)).cookie;
  userCookie = (await createAccount(services, { email: "member@example.test", role: "user" }))
    .cookie;

  await seedKosyncFor(adminCookie, "admin-kosync");
  await seedKosyncFor(userCookie, "user-kosync");
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST", body: { includeAuth: true } });
});

describe("GET /api/reading-status/counts", () => {
  it("answers with real numbers rather than a driver-shape error", async () => {
    // The assertion that fails against the pre-fix route: it 500s with
    // "result is not iterable" on PGlite, so `status` is 500 and `data` has no
    // counts at all. Nothing about the SQL or the scoping is under test here —
    // only that the endpoint can run on the harness everything else runs on.
    await seedBooks(["a", "b"]);

    expect(await counts(adminCookie)).toEqual({ unread: 2, reading: 0, finished: 0, paused: 0 });
  });

  it("counts every organized book, in exactly one status each", async () => {
    await seedBooks(["done", "midway", "untouched"]);

    await sync("admin-kosync", "done", 0.99);
    await sync("admin-kosync", "midway", 0.4);

    expect(await counts(adminCookie)).toEqual({
      unread: 1,
      reading: 1,
      finished: 1,
      paused: 0,
    });
  });

  it("counts a book as finished for the reader who finished it, unread for everyone else", async () => {
    await seedBooks(["shared"]);

    await sync("admin-kosync", "shared", 0.99);

    expect(await counts(adminCookie)).toMatchObject({ finished: 1, unread: 0 });
    // Same book, same library, a different person: they have not read it.
    expect(await counts(userCookie)).toMatchObject({ finished: 0, unread: 1 });
  });

  it("keeps two readers at different statuses on the same book", async () => {
    await seedBooks(["shared"]);

    await sync("admin-kosync", "shared", 0.99);
    await sync("user-kosync", "shared", 0.4);

    expect(await counts(adminCookie)).toMatchObject({ finished: 1, reading: 0 });
    expect(await counts(userCookie)).toMatchObject({ finished: 0, reading: 1 });
  });
});

describe("GET /api/reading-status/{status}", () => {
  it("lists a book under a status only for the reader who is at it", async () => {
    await seedBooks(["mine", "theirs"]);

    await sync("admin-kosync", "mine", 0.99);
    await sync("user-kosync", "theirs", 0.99);

    expect(await listByStatus(adminCookie, "finished")).toEqual(["mine"]);
    expect(await listByStatus(userCookie, "finished")).toEqual(["theirs"]);
  });

  it("agrees with the counts endpoint on how many books are in a status", async () => {
    await seedBooks(["x", "y", "z"]);

    await sync("admin-kosync", "x", 0.99);
    await sync("admin-kosync", "y", 0.99);

    const byStatus = await counts(adminCookie);
    expect((await listByStatus(adminCookie, "finished")).length).toBe(byStatus.finished);
    expect((await listByStatus(adminCookie, "unread")).length).toBe(byStatus.unread);
  });
});
