import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { eq, count, desc, inArray } from "drizzle-orm";
import { books, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { cachedRoute } from "../../middleware/cache.js";
import { buildFeed, paginationLinks, OPDS_MIME_ACQUISITION } from "../../shared/opds-xml.js";
import { getBaseUrl, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const newArrivalsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "New arrivals (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of recently added books, sorted by creation date (newest first).",
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
      description: "OPDS acquisition feed of new arrivals (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsNewRoutes = createOpenApiRouter<{ Variables: AppVariables }>().openapi(
  newArrivalsRoute,
  async (c) => {
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
        .select()
        .from(books)
        .where(where)
        .orderBy(desc(books.createdAt))
        .limit(perPage)
        .offset(offset),
    ]);

    const total = totalResult[0]?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    // Fetch files for all books in one query
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

    const selfHref = `${baseUrl}/opds/new`;
    const xml = buildFeed(
      {
        id: "urn:libris:opds:new",
        title: "New Arrivals",
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
