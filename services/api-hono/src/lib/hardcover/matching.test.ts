import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { matchBooksToHardcover, backfillEditionPageCounts } from "./matching";

// ── Mocks ───────────────────────────────────────────────────────

vi.mock("./client", () => ({
  findEditionByIsbn: vi.fn(),
  getEditionPages: vi.fn(),
}));

// Import after mock so we get the mocked versions
import { findEditionByIsbn, getEditionPages } from "./client";

const mockFindEdition = vi.mocked(findEditionByIsbn);
const mockGetEditionPages = vi.mocked(getEditionPages);

function makeFakeDb(
  rows: Array<{ id: string; isbn13: string | null; isbn10: string | null; title: string | null }>,
) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;
}

function makeBackfillFakeDb(
  rows: Array<{
    id: string;
    title: string | null;
    pageCount: number | null;
    hardcoverEditionId: number | null;
  }>,
) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Prevent actual delays in tests
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any) => {
    fn();
    return 0 as any;
  });
});

// ── matchBooksToHardcover ───────────────────────────────────────

describe("matchBooksToHardcover", () => {
  it("resets rate limit retries between books", async () => {
    // Book A will get rate-limited 3 times then succeed.
    // Book B will get rate-limited 3 times then succeed.
    // Without reset, book B would start at 3 retries and fail at 6 > 5.
    // With reset, each book gets a fresh budget of 5 retries.
    const books = [
      { id: "book-a", isbn13: "9780000000001", isbn10: null, title: "Book A" },
      { id: "book-b", isbn13: "9780000000002", isbn10: null, title: "Book B" },
    ];

    const db = makeFakeDb(books);

    let callCountA = 0;
    let callCountB = 0;

    mockFindEdition.mockImplementation(async (_token, isbn13) => {
      if (isbn13 === "9780000000001") {
        callCountA++;
        if (callCountA <= 3) {
          return { ok: false, error: { type: "rate_limited" as const } };
        }
        return {
          ok: true,
          data: { bookId: 100, editionId: 200, pages: 300 },
        };
      }
      if (isbn13 === "9780000000002") {
        callCountB++;
        if (callCountB <= 3) {
          return { ok: false, error: { type: "rate_limited" as const } };
        }
        return {
          ok: true,
          data: { bookId: 101, editionId: 201, pages: 301 },
        };
      }
      return { ok: true, data: null };
    });

    const result = await matchBooksToHardcover(db, "test-token");

    // Both books should be matched successfully
    expect(result.matched).toBe(2);
    expect(result.failed).toBe(0);
    // Book A: 3 rate limits + 1 success = 4 calls
    // Book B: 3 rate limits + 1 success = 4 calls
    expect(callCountA).toBe(4);
    expect(callCountB).toBe(4);
  });

  it("counts a book as failed when it exceeds MAX_RATE_LIMIT_RETRIES", async () => {
    const books = [
      { id: "book-a", isbn13: "9780000000001", isbn10: null, title: "Book A" },
      { id: "book-b", isbn13: "9780000000002", isbn10: null, title: "Book B" },
    ];

    const db = makeFakeDb(books);

    // Book A always rate-limited; book B succeeds immediately
    mockFindEdition.mockImplementation(async (_token, isbn13) => {
      if (isbn13 === "9780000000001") {
        return { ok: false, error: { type: "rate_limited" as const } };
      }
      return { ok: true, data: { bookId: 101, editionId: 201, pages: 301 } };
    });

    const result = await matchBooksToHardcover(db, "test-token");

    // Book A should fail after exhausting retries, book B should still succeed
    expect(result.failed).toBe(1);
    expect(result.matched).toBe(1);
  });
});

// ── backfillEditionPageCounts ───────────────────────────────────

describe("backfillEditionPageCounts", () => {
  it("resets rate limit retries between books", async () => {
    const books = [
      { id: "book-a", title: "Book A", pageCount: null, hardcoverEditionId: 200 },
      { id: "book-b", title: "Book B", pageCount: null, hardcoverEditionId: 201 },
    ];

    const db = makeBackfillFakeDb(books);

    let callCountA = 0;
    let callCountB = 0;

    mockGetEditionPages.mockImplementation(async (_token, editionId) => {
      if (editionId === 200) {
        callCountA++;
        if (callCountA <= 3) {
          return { ok: false, error: { type: "rate_limited" as const } };
        }
        return { ok: true, data: 300 };
      }
      if (editionId === 201) {
        callCountB++;
        if (callCountB <= 3) {
          return { ok: false, error: { type: "rate_limited" as const } };
        }
        return { ok: true, data: 301 };
      }
      return { ok: true, data: null };
    });

    const result = await backfillEditionPageCounts(db, "test-token");

    // Both books should be updated successfully
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect(callCountA).toBe(4);
    expect(callCountB).toBe(4);
  });

  it("counts a book as failed when it exceeds MAX_RATE_LIMIT_RETRIES", async () => {
    const books = [
      { id: "book-a", title: "Book A", pageCount: null, hardcoverEditionId: 200 },
      { id: "book-b", title: "Book B", pageCount: null, hardcoverEditionId: 201 },
    ];

    const db = makeBackfillFakeDb(books);

    // Book A always rate-limited; book B succeeds immediately
    mockGetEditionPages.mockImplementation(async (_token, editionId) => {
      if (editionId === 200) {
        return { ok: false, error: { type: "rate_limited" as const } };
      }
      return { ok: true, data: 301 };
    });

    const result = await backfillEditionPageCounts(db, "test-token");

    // Book A should fail after exhausting retries, book B should still succeed
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
  });
});
