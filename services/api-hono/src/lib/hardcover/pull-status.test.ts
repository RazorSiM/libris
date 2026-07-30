import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

vi.mock("./client", () => ({
  getUserBooks: vi.fn(),
}));

import { getUserBooks } from "./client";
import { mapHardcoverStatus, pullHardcoverStatusesForUser } from "./pull-status";

const mockGetUserBooks = vi.mocked(getUserBooks);

beforeEach(() => {
  mockGetUserBooks.mockReset();
});

describe("mapHardcoverStatus", () => {
  it("maps all known status ids", () => {
    expect(mapHardcoverStatus(1)).toBe("unread");
    expect(mapHardcoverStatus(2)).toBe("reading");
    expect(mapHardcoverStatus(3)).toBe("finished");
    expect(mapHardcoverStatus(4)).toBe("paused");
  });

  it("folds DNF (5) into paused", () => {
    expect(mapHardcoverStatus(5)).toBe("paused");
  });

  it("returns null for unknown status ids", () => {
    expect(mapHardcoverStatus(0)).toBeNull();
    expect(mapHardcoverStatus(99)).toBeNull();
  });
});

describe("pullHardcoverStatusesForUser", () => {
  function makeFakeDb(
    matchedBooks: Array<{ id: string; hardcoverBookId: number | null }>,
    onUpsert: (values: Record<string, unknown>) => void,
  ) {
    const db: unknown = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(matchedBooks),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: () => {
            onUpsert(values);
            return Promise.resolve();
          },
        }),
      }),
    };
    return db as Parameters<typeof pullHardcoverStatusesForUser>[0];
  }

  it("upserts external_status for matched local books only", async () => {
    mockGetUserBooks.mockResolvedValueOnce({
      ok: true,
      data: [
        { bookId: 100, statusId: 3 },
        { bookId: 200, statusId: 2 },
        { bookId: 999, statusId: 4 },
      ],
    });

    const upserts: Record<string, unknown>[] = [];
    const db = makeFakeDb(
      [
        { id: "uuid-100", hardcoverBookId: 100 },
        { id: "uuid-200", hardcoverBookId: 200 },
      ],
      (values) => upserts.push(values),
    );

    const result = await pullHardcoverStatusesForUser(db, "token", "api-key-1");

    expect(result.fetched).toBe(3);
    expect(result.matched).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.unknown).toBe(0);

    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toMatchObject({
      apiKeyId: "api-key-1",
      bookId: "uuid-100",
      externalStatus: "finished",
    });
    expect(upserts[1]).toMatchObject({
      apiKeyId: "api-key-1",
      bookId: "uuid-200",
      externalStatus: "reading",
    });
  });

  it("counts unknown status ids and skips them", async () => {
    mockGetUserBooks.mockResolvedValueOnce({
      ok: true,
      data: [
        { bookId: 100, statusId: 3 },
        { bookId: 200, statusId: 99 },
      ],
    });

    const upserts: Record<string, unknown>[] = [];
    const db = makeFakeDb(
      [
        { id: "uuid-100", hardcoverBookId: 100 },
        { id: "uuid-200", hardcoverBookId: 200 },
      ],
      (values) => upserts.push(values),
    );

    const result = await pullHardcoverStatusesForUser(db, "token", "api-key-1");

    expect(result.upserted).toBe(1);
    expect(result.unknown).toBe(1);
    expect(upserts).toHaveLength(1);
  });

  it("returns zeros and does not upsert when getUserBooks fails", async () => {
    mockGetUserBooks.mockResolvedValueOnce({
      ok: false,
      error: { type: "rate_limited" },
    });

    const upserts: Record<string, unknown>[] = [];
    const db = makeFakeDb([], (values) => upserts.push(values));

    const result = await pullHardcoverStatusesForUser(db, "token", "api-key-1");

    expect(result).toEqual({ fetched: 0, matched: 0, upserted: 0, unknown: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("returns zeros when user has no Hardcover user_books", async () => {
    mockGetUserBooks.mockResolvedValueOnce({ ok: true, data: [] });

    const upserts: Record<string, unknown>[] = [];
    const db = makeFakeDb([], (values) => upserts.push(values));

    const result = await pullHardcoverStatusesForUser(db, "token", "api-key-1");

    expect(result).toEqual({ fetched: 0, matched: 0, upserted: 0, unknown: 0 });
    expect(upserts).toHaveLength(0);
  });
});
