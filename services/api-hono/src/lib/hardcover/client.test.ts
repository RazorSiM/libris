import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

vi.mock("ofetch", () => ({
  ofetch: vi.fn(),
}));

import { ofetch } from "ofetch";
import { getUserBooks } from "./client";

const mockOfetch = vi.mocked(ofetch);

beforeEach(() => {
  mockOfetch.mockReset();
});

describe("getUserBooks", () => {
  it("paginates until a short page is returned", async () => {
    const pageSize = 2;
    mockOfetch
      .mockResolvedValueOnce({
        data: {
          me: [
            {
              user_books: [
                { book_id: 1, status_id: 3 },
                { book_id: 2, status_id: 2 },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          me: [
            {
              user_books: [
                { book_id: 3, status_id: 1 },
                { book_id: 4, status_id: 4 },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { me: [{ user_books: [{ book_id: 5, status_id: 5 }] }] },
      });

    const result = await getUserBooks("token", { pageSize });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { bookId: 1, statusId: 3 },
      { bookId: 2, statusId: 2 },
      { bookId: 3, statusId: 1 },
      { bookId: 4, statusId: 4 },
      { bookId: 5, statusId: 5 },
    ]);
    expect(mockOfetch).toHaveBeenCalledTimes(3);

    const offsets = mockOfetch.mock.calls.map((call) => {
      const body = (call[1] as { body: { variables: { offset: number } } }).body;
      return body.variables.offset;
    });
    expect(offsets).toEqual([0, 2, 4]);
  });

  it("stops after the first page when fewer rows than pageSize are returned", async () => {
    mockOfetch.mockResolvedValueOnce({
      data: { me: [{ user_books: [{ book_id: 1, status_id: 2 }] }] },
    });

    const result = await getUserBooks("token", { pageSize: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ bookId: 1, statusId: 2 }]);
    expect(mockOfetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty list when user has no user_books", async () => {
    mockOfetch.mockResolvedValueOnce({
      data: { me: [{ user_books: [] }] },
    });

    const result = await getUserBooks("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });

  it("propagates rate-limit errors from the GraphQL helper", async () => {
    const err = Object.assign(new Error("429"), { status: 429 });
    mockOfetch.mockRejectedValueOnce(err);

    const result = await getUserBooks("token");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("rate_limited");
  });
});
