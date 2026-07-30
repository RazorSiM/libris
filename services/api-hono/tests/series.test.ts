import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createTestApp, createFetchHelper } from "./setup.js";
import type { Db } from "../src/db/client.js";
import { books } from "../src/db/schema.js";

// ── App-level state ────────────────────────────────────────────────

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;

// ── Per-test state ─────────────────────────────────────────────

let apiKey: string;

function auth() {
  return { authorization: `Bearer ${apiKey}` };
}

// ── App lifecycle: create once ─────────────────────────────────────

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
});

// ── Per-test lifecycle: clean DB → create fresh key ──────────────

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });

  const { data, status } = await $fetchRaw("/api/auth/setup", {
    method: "POST",
    body: { label: "integration-test-key" },
  });
  expect(status).toBe(201);
  apiKey = data.key;
});

afterEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

// ── Series list ───────────────────────────────────────────────────

describe("GET /api/series", () => {
  it("returns empty list when no books exist", async () => {
    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("excludes books without a series", async () => {
    // Seed books WITHOUT a series
    await $fetchRaw("/__test/seed-books", {
      method: "POST",
      body: {
        books: [
          { title: "Standalone Book 1", status: "organized" },
          { title: "Standalone Book 2", status: "organized" },
        ],
      },
    });

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("returns series with book count and cover", async () => {
    // Seed books with series directly via DB (seed-books doesn't support series field)
    await testDb.insert(books).values([
      {
        title: "Book 1",
        author: "Author",
        series: "My Series",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/volume1.jpg",
      },
      {
        title: "Book 2",
        author: "Author",
        series: "My Series",
        seriesIndex: 2,
        status: "organized",
        coverPath: "/covers/volume2.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].name).toBe("My Series");
    expect(data.data[0].bookCount).toBe(2);
  });

  it("picks cover from first book by seriesIndex", async () => {
    // Seed books with different seriesIndex values
    await testDb.insert(books).values([
      {
        title: "Volume 3",
        series: "Series A",
        seriesIndex: 3,
        status: "organized",
        coverPath: "/covers/v3.jpg",
      },
      {
        title: "Volume 1",
        series: "Series A",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/v1.jpg",
      },
      {
        title: "Volume 2",
        series: "Series A",
        seriesIndex: 2,
        status: "organized",
        coverPath: "/covers/v2.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    // Should pick cover from volume 1 (lowest seriesIndex)
    expect(data.data[0].coverPath).toBe("/covers/v1.jpg");
  });

  it("handles books with null seriesIndex (sorts them last)", async () => {
    // Seed books where one has null seriesIndex
    await testDb.insert(books).values([
      {
        title: "Volume with index",
        series: "Series B",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/indexed.jpg",
      },
      {
        title: "Volume without index",
        series: "Series B",
        seriesIndex: null,
        status: "organized",
        coverPath: "/covers/null-index.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    // Should pick cover from book with seriesIndex (not null)
    expect(data.data[0].coverPath).toBe("/covers/indexed.jpg");
  });

  it("returns multiple series with correct covers", async () => {
    await testDb.insert(books).values([
      {
        title: "Series A Vol 2",
        series: "Series A",
        seriesIndex: 2,
        status: "organized",
        coverPath: "/covers/a2.jpg",
      },
      {
        title: "Series A Vol 1",
        series: "Series A",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/a1.jpg",
      },
      {
        title: "Series B Vol 1",
        series: "Series B",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/b1.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(2);

    const seriesA = data.data.find((s: { name: string }) => s.name === "Series A");
    const seriesB = data.data.find((s: { name: string }) => s.name === "Series B");

    expect(seriesA?.coverPath).toBe("/covers/a1.jpg");
    expect(seriesB?.coverPath).toBe("/covers/b1.jpg");
  });

  it("excludes books that are not 'organized' status", async () => {
    await testDb.insert(books).values([
      {
        title: "Organized Book",
        series: "Test Series",
        seriesIndex: 1,
        status: "organized",
        coverPath: "/covers/organized.jpg",
      },
      {
        title: "Inbox Book",
        series: "Test Series",
        seriesIndex: 2,
        status: "inbox",
        coverPath: "/covers/inbox.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].bookCount).toBe(1);
    expect(data.data[0].coverPath).toBe("/covers/organized.jpg");
  });

  it("picks cover from organized book even when a non-organized book has a lower seriesIndex", async () => {
    await testDb.insert(books).values([
      {
        title: "Inbox V1",
        series: "Test Series",
        seriesIndex: 1,
        status: "inbox",
        coverPath: "/covers/inbox.jpg",
      },
      {
        title: "Organized V2",
        series: "Test Series",
        seriesIndex: 2,
        status: "organized",
        coverPath: "/covers/organized.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].coverPath).toBe("/covers/organized.jpg");
  });

  it("falls back to any organized book when no book has a seriesIndex", async () => {
    await testDb.insert(books).values([
      {
        title: "Book 1",
        series: "Series C",
        seriesIndex: null,
        status: "organized",
        coverPath: "/covers/c1.jpg",
      },
      {
        title: "Book 2",
        series: "Series C",
        seriesIndex: null,
        status: "organized",
        coverPath: "/covers/c2.jpg",
      },
    ]);

    const { data, status } = await $fetchRaw("/api/series", { headers: auth() });

    expect(status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].name).toBe("Series C");
    expect(data.data[0].bookCount).toBe(2);
    // The representative book is picked by created_at when no seriesIndex is set;
    // the point is that SOME cover comes back rather than the null the old query returned.
    expect(data.data[0].coverPath).not.toBeNull();
    expect(["/covers/c1.jpg", "/covers/c2.jpg"]).toContain(data.data[0].coverPath);
    expect(data.data[0].coverBookId).not.toBeNull();
  });
});
