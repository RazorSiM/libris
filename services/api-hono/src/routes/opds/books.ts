import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, count, inArray, and } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { cachedRoute } from "../../middleware/cache.js";
import {
  buildFeed,
  paginationLinks,
  OPDS_MIME_ACQUISITION,
  OPDS_MIME_ENTRY,
} from "../../shared/opds-xml.js";
import { getBaseUrl, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const listBooksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "List all books (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of all organized books, sorted alphabetically by title. Supports page-based pagination via query parameter.",
  middleware: [cachedRoute({ maxAge: 60 })] as const,
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().openapi({
        description: "Page number (1-based)",
        example: 1,
      }),
    }),
  },
  responses: {
    200: {
      description: "OPDS acquisition feed with book entries (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

const getBookRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["opds"],
  summary: "Get a single book entry (OPDS)",
  description:
    "Returns an OPDS entry document for a single organized book, including metadata and acquisition links for available file formats.",
  middleware: [cachedRoute({ maxAge: 60 })] as const,
  request: {
    params: z.object({
      id: z
        .string()
        .uuid()
        .openapi({ description: "Book UUID", example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      description: "OPDS entry document for the book (Atom XML)",
      content: {
        [OPDS_MIME_ENTRY]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
    400: { description: "Invalid book ID" },
    404: { description: "Book not found" },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsBooksRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(listBooksRoute, async (c) => {
    const { page: rawPage } = c.req.valid("query");
    const page = rawPage ?? 1;
    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");

    const where = eq(books.status, "organized");

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

    const selfHref = `${baseUrl}/opds/books`;
    const xml = buildFeed(
      {
        id: "urn:libris:opds:books",
        title: "All Books",
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
  })

  .openapi(getBookRoute, async (c) => {
    const { id } = c.req.valid("param");

    const db = c.get("db");
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));

    const [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    const files = await db
      .select({ id: bookFiles.id, format: bookFiles.format })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    const entry = bookToEntry(book, files, baseUrl);

    const xml = buildFeed(
      {
        id: `urn:libris:opds:books:${id}`,
        title: book.title ?? "Untitled",
        updated: book.updatedAt,
        selfHref: `${baseUrl}/opds/books/${id}`,
        selfType: OPDS_MIME_ENTRY,
        startHref: `${baseUrl}/opds`,
      },
      [entry],
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_ENTRY },
    });
  });
