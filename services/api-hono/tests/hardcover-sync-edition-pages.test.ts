import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { Env } from "../src/env.js";
import {
  books,
  hardcoverSyncLog,
  readingProgress,
  readingProgressHistory,
  serviceCredentials,
} from "../src/db/schema.js";
import { findBooksToSyncToHardcover } from "../src/lib/hardcover/sync-candidates.js";

// Mock only the network-touching seams. Metadata is left disabled so the
// matching/backfill phases (which would also call the client) are skipped.
vi.mock("../src/lib/hardcover/client.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hardcover/client.js")>()),
  verifyToken: vi.fn(),
  upsertUserBook: vi.fn(),
  upsertUserBookRead: vi.fn(),
  updateUserBookRead: vi.fn(),
  getEditionPages: vi.fn(),
}));
vi.mock("../src/lib/hardcover/pull-status.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hardcover/pull-status.js")>()),
  pullHardcoverStatusesForUser: vi.fn().mockResolvedValue({ fetched: 0, upserted: 0, unknown: 0 }),
}));
vi.mock("../src/services/settings.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/settings.js")>()),
  isHardcoverMetadataEnabled: vi.fn().mockResolvedValue(false),
  isHardcoverSyncEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/shared/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/shared/auth.js")>()),
  unsealToken: vi.fn().mockResolvedValue("test-token"),
}));

import * as client from "../src/lib/hardcover/client.js";
import { processHardcoverSync } from "../src/workers/hardcover-sync.js";

const testEnv: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "pglite://",
  REDIS_URL: "redis://localhost:6379",
  LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
  LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
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

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let apiKeyId: string;

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  const { __setTestEnv } = await import("../src/env.js");
  __setTestEnv(testEnv);
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
  const { data, status } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "integration-test-key" },
  });
  expect(status).toBe(201);
  apiKeyId = data.id;

  await testDb.insert(serviceCredentials).values({
    service: "hardcover",
    apiKeyId,
    username: "Raz",
    passwordHash: "sealed-token",
  });

  vi.mocked(client.verifyToken).mockResolvedValue({
    ok: true,
    data: { id: 1, username: "Raz" },
  });
  vi.mocked(client.upsertUserBook).mockResolvedValue({ ok: true, data: { userBookId: 42 } });
  vi.mocked(client.upsertUserBookRead).mockResolvedValue({ ok: true, data: { readId: 7 } });
  vi.mocked(client.updateUserBookRead).mockResolvedValue({ ok: true, data: { readId: 7 } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

async function seedFinishedBook(opts: { editionId: number; pageCount: number }) {
  const [book] = await testDb
    .insert(books)
    .values({
      title: "Ghostwater",
      author: "Will Wight",
      status: "organized",
      hardcoverBookId: 446392,
      hardcoverEditionId: opts.editionId,
      pageCount: opts.pageCount,
    })
    .returning({ id: books.id });
  const ts = Math.floor(Date.now() / 1000);
  await testDb.insert(readingProgress).values({
    bookId: book!.id,
    apiKeyId,
    document: "ghostwater-doc",
    device: "komodo",
    progress: "0",
    percentage: "1.0000",
    timestamp: BigInt(ts),
  });
  await testDb.insert(readingProgressHistory).values({
    bookId: book!.id,
    apiKeyId,
    document: "ghostwater-doc",
    device: "komodo",
    progress: "0",
    percentage: "1.0000",
    timestamp: BigInt(ts),
    createdAt: new Date(ts * 1000),
  });
  return book!.id;
}

const fakeJob = { updateProgress: vi.fn(), log: vi.fn() };

describe("hardcover-sync edition page count handling (libris-26gy)", () => {
  it("syncs a read (with finished_at, no page progress) when the edition has null pages", async () => {
    const bookId = await seedFinishedBook({ editionId: 32769766, pageCount: 312 });
    vi.mocked(client.getEditionPages).mockResolvedValue({ ok: true, data: null });

    await processHardcoverSync({ ...fakeJob, data: { apiKeyId } } as never);

    // The read was still pushed — status finished, dates set, but no page progress
    // (we never invent a page number from a different page basis).
    expect(client.upsertUserBookRead).toHaveBeenCalledTimes(1);
    const params = vi.mocked(client.upsertUserBookRead).mock.calls[0]![1];
    expect(params.progressPages).toBeUndefined();
    expect(params.editionId).toBe(32769766);
    expect(params.finishedAt).toBeTruthy();

    // A sync-log row is written, so the book is no longer a perpetual candidate.
    const [logRow] = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(and(eq(hardcoverSyncLog.apiKeyId, apiKeyId), eq(hardcoverSyncLog.bookId, bookId)));
    expect(logRow).toBeDefined();
    expect(logRow!.lastStatus).toBe("finished");
    expect(logRow!.lastProgress).toBe("1.0000");

    const remaining = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(remaining).toHaveLength(0);
  });

  it("converts percentage to a page number when the edition has a page count", async () => {
    await seedFinishedBook({ editionId: 32542955, pageCount: 999 });
    vi.mocked(client.getEditionPages).mockResolvedValue({ ok: true, data: 526 });

    await processHardcoverSync({ ...fakeJob, data: { apiKeyId } } as never);

    expect(client.upsertUserBookRead).toHaveBeenCalledTimes(1);
    const params = vi.mocked(client.upsertUserBookRead).mock.calls[0]![1];
    // round(1.0 * 526) — uses the edition's pages, not the local pageCount (999).
    expect(params.progressPages).toBe(526);
    expect(params.finishedAt).toBeTruthy();
  });

  it("does NOT mark progress synced on a transient edition-pages fetch error", async () => {
    const bookId = await seedFinishedBook({ editionId: 32613392, pageCount: 292 });
    vi.mocked(client.getEditionPages).mockResolvedValue({
      ok: false,
      error: { type: "api_error", message: "boom" },
    });

    await processHardcoverSync({ ...fakeJob, data: { apiKeyId } } as never);

    // No read pushed; sync-log records the status but leaves progress unsynced
    // so the book stays a candidate and retries next run.
    expect(client.upsertUserBookRead).not.toHaveBeenCalled();
    const [logRow] = await testDb
      .select()
      .from(hardcoverSyncLog)
      .where(and(eq(hardcoverSyncLog.apiKeyId, apiKeyId), eq(hardcoverSyncLog.bookId, bookId)));
    expect(logRow!.lastProgress).toBeNull();

    const remaining = await findBooksToSyncToHardcover(testDb, apiKeyId);
    expect(remaining).toHaveLength(1);
  });
});
