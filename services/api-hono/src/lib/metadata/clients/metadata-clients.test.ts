import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Mock credential lookup — Hardcover client calls getDb() + unsealToken() to load API token
const mockCredRow = { passwordHash: "sealed:test-key" };
const chainedQuery = {
  select: () => chainedQuery,
  from: () => chainedQuery,
  where: () => chainedQuery,
  limit: () => [mockCredRow],
};

vi.mock("../../../services/db", () => ({
  getDb: () => chainedQuery,
}));

vi.mock("../../../env", () => ({
  getEnv: () => ({ API_SECRET_KEY: "test-secret-key-at-least-32-characters!" }),
}));

vi.mock("../../../shared/auth", () => ({
  unsealToken: () => Promise.resolve("test-api-key"),
}));

vi.mock("../../../services/settings", () => ({
  isHardcoverMetadataEnabled: () => Promise.resolve(true),
  isHardcoverSyncEnabled: () => Promise.resolve(true),
}));

const { searchHardcover } = await import("./hardcover");

const HARDCOVER_URL = "https://api.hardcover.app/v1/graphql";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("searchHardcover", () => {
  it("returns empty array when query has no fields", async () => {
    const result = await searchHardcover({});
    expect(result).toEqual([]);
  });

  it("returns empty array on network timeout", async () => {
    server.use(http.post(HARDCOVER_URL, () => HttpResponse.error()));

    const result = await searchHardcover({ title: "Test Book" });
    expect(result).toEqual([]);
  });

  it("returns empty array on HTTP 429 rate limit", async () => {
    server.use(http.post(HARDCOVER_URL, () => new HttpResponse(null, { status: 429 })));

    const result = await searchHardcover({ title: "Test Book" });
    expect(result).toEqual([]);
  });

  it("returns empty array when response schema doesn't match", async () => {
    server.use(http.post(HARDCOVER_URL, () => HttpResponse.json({ wrong: "format" })));

    const result = await searchHardcover({ title: "Test" });
    expect(result).toEqual([]);
  });

  it("skips hits with null document", async () => {
    server.use(
      http.post(HARDCOVER_URL, () =>
        HttpResponse.json({
          data: {
            search: {
              results: {
                hits: [{ document: null }, { document: null }],
              },
            },
          },
        }),
      ),
    );

    const result = await searchHardcover({ title: "Test" });
    expect(result).toEqual([]);
  });

  it("normalizes a valid flat Typesense response", async () => {
    server.use(
      http.post(HARDCOVER_URL, () =>
        HttpResponse.json({
          data: {
            search: {
              results: {
                hits: [
                  {
                    document: {
                      id: "123",
                      title: "Hardcover Book",
                      slug: "hardcover-book",
                      release_year: 2023,
                      pages: 400,
                      description: "A book from Hardcover",
                      image: { url: "https://hardcover.app/cover.jpg" },
                      isbns: ["1234567890", "9781234567897"],
                      author_names: ["HC Author"],
                      genres: ["Fiction", "Adventure"],
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    const result = await searchHardcover({ title: "Hardcover Book" });

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("hardcover");
    expect(result[0].confidence).toBe(0.88);
    expect(result[0].normalized.title).toBe("Hardcover Book");
    expect(result[0].normalized.author).toBe("HC Author");
    expect(result[0].normalized.isbn10).toBe("1234567890");
    expect(result[0].normalized.isbn13).toBe("9781234567897");
    expect(result[0].normalized.coverUrl).toBe("https://hardcover.app/cover.jpg");
    expect(result[0].normalized.genres).toContain("Fiction");
    expect(result[0].normalized.genres).toContain("Adventure");
  });

  it("handles document with no author_names", async () => {
    server.use(
      http.post(HARDCOVER_URL, () =>
        HttpResponse.json({
          data: {
            search: {
              results: {
                hits: [
                  {
                    document: {
                      id: "2",
                      title: "No Author Book",
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    const result = await searchHardcover({ title: "No Author" });

    expect(result).toHaveLength(1);
    expect(result[0].normalized.author).toBeUndefined();
    expect(result[0].normalized.genres).toEqual([]);
  });

  it("uses ISBN as search term when provided", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(HARDCOVER_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: { search: { results: { hits: [] } } },
        });
      }),
    );

    await searchHardcover({ isbn: "9781234567897", title: "Test" });

    expect(capturedBody).toBeDefined();
    expect(capturedBody).toEqual(
      expect.objectContaining({
        variables: { query: "9781234567897" },
      }),
    );
  });

  it("falls back to title+author when ISBN has bad check digit", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(HARDCOVER_URL, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: { search: { results: { hits: [] } } },
        });
      }),
    );

    await searchHardcover({ isbn: "2100906924", title: "Test", author: "Author" });

    expect(capturedBody).toBeDefined();
    expect(capturedBody).toEqual(
      expect.objectContaining({
        variables: { query: "Test Author" },
      }),
    );
  });
});

describe("redirect restriction (SSRF prevention)", () => {
  it("Hardcover does not follow redirects", async () => {
    server.use(
      http.post(
        HARDCOVER_URL,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data/" },
          }),
      ),
    );

    const result = await searchHardcover({ title: "Test" });
    expect(result).toEqual([]);
  });
});
