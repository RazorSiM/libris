import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { eq, and, count, sql, inArray } from "drizzle-orm";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { cachedRoute } from "../../middleware/cache.js";
import { buildFeed, paginationLinks, OPDS_MIME_ACQUISITION } from "../../shared/opds-xml.js";
import { getBaseUrl, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const authorBooksRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["opds"],
  summary: "Books by author (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of books by a specific author, identified by a URL-friendly slug derived from the author name.",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  request: {
    params: z.object({
      slug: z.string().min(1).max(500).openapi({ description: "URL-friendly author slug" }),
    }),
    query: z.object({
      page: z.coerce.number().int().min(1).optional().openapi({
        description: "Page number (1-based)",
        example: 1,
      }),
    }),
  },
  responses: {
    200: {
      description: "OPDS acquisition feed of books by the author (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsAuthorsRoutes = createOpenApiRouter<{ Variables: AppVariables }>().openapi(
  authorBooksRoute,
  async (c) => {
    const { slug } = c.req.valid("param");
    const { page: rawPage } = c.req.valid("query");
    const page = rawPage ?? 1;

    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");

    // Match slug against slugified author name in SQL
    const where = and(
      eq(books.status, "organized"),
      sql`lower(regexp_replace(regexp_replace(${books.author}, '\s+', '-', 'g'), '[^a-z0-9-]', '', 'gi')) = ${slug}`,
    );

    const [totalResult, items] = await Promise.all([
      db.select({ count: count() }).from(books).where(where),
      db
        .select(bookColumns)
        .from(books)
        .where(where)
        .orderBy(books.title)
        .limit(perPage)
        .offset(offset),
    ]);

    const total = totalResult[0]?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    const bookIds = items.map((b) => b.id);
    const files =
      bookIds.length > 0
        ? await db
            .select({ id: bookFiles.id, bookId: bookFiles.bookId, format: bookFiles.format })
            .from(bookFiles)
            .where(inArray(bookFiles.bookId, bookIds))
        : [];

    const filesByBook = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByBook.get(f.bookId) ?? [];
      arr.push(f);
      filesByBook.set(f.bookId, arr);
    }

    const entries = items.map((book) => bookToEntry(book, filesByBook.get(book.id) ?? [], baseUrl));

    // Derive display name from first matching book, or de-slug the param
    const authorName =
      items[0]?.author ?? slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

    const selfHref = `${baseUrl}/opds/authors/${encodeURIComponent(slug)}`;
    const xml = buildFeed(
      {
        id: `urn:libris:opds:authors:${slug}`,
        title: `Books by ${authorName}`,
        selfHref,
        selfType: OPDS_MIME_ACQUISITION,
        startHref: `${baseUrl}/opds`,
      },
      entries,
      paginationLinks({
        currentPage: page,
        totalPages,
        perPage,
        totalResults: total,
        baseHref: selfHref,
      }),
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_ACQUISITION },
    });
  },
);
