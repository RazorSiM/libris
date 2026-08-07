import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { cachedRoute } from "../../middleware/cache.js";
import {
  buildFeed,
  navigationEntry,
  paginationLinks,
  OPDS_MIME_ACQUISITION,
  OPDS_MIME_NAVIGATION,
} from "../../shared/opds-xml.js";
import { getBaseUrl, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const listSeriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "List series (OPDS)",
  description:
    "Returns an OPDS navigation feed listing all book series found in organized books, each linking to a series-specific acquisition feed.",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  responses: {
    200: {
      description: "OPDS navigation feed of series (Atom XML)",
      content: {
        [OPDS_MIME_NAVIGATION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

const seriesBooksRoute = createRoute({
  method: "get",
  path: "/{name}",
  tags: ["opds"],
  summary: "Books in a series (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of books in a specific series, ordered by series index.",
  middleware: [cachedRoute({ maxAge: 60 })] as const,
  request: {
    params: z.object({
      name: z.string().min(1).max(500).openapi({ description: "Series name" }),
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
      description: "OPDS acquisition feed of books in the series (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsSeriesRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(listSeriesRoute, async (c) => {
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");
    const now = new Date();

    const rows = await db
      .select({
        series: books.series,
        bookCount: count(books.id),
      })
      .from(books)
      .where(and(eq(books.status, "organized"), isNotNull(books.series)))
      .groupBy(books.series)
      .orderBy(asc(books.series));

    const entries = rows
      .filter((r): r is typeof r & { series: string } => r.series !== null)
      .map((row) =>
        navigationEntry({
          id: `urn:libris:opds:series:${encodeURIComponent(row.series)}`,
          title: row.series,
          updated: now,
          content: `${row.bookCount} book${row.bookCount === 1 ? "" : "s"}`,
          link: {
            rel: "subsection",
            href: `${baseUrl}/opds/series/${encodeURIComponent(row.series)}`,
            type: OPDS_MIME_ACQUISITION,
          },
        }),
      );

    const xml = buildFeed(
      {
        id: "urn:libris:opds:series",
        title: "Series",
        updated: now,
        selfHref: `${baseUrl}/opds/series`,
        selfType: OPDS_MIME_NAVIGATION,
        startHref: `${baseUrl}/opds`,
      },
      entries,
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_NAVIGATION },
    });
  })

  .openapi(seriesBooksRoute, async (c) => {
    const { name } = c.req.valid("param");
    const { page: rawPage } = c.req.valid("query");
    const page = rawPage ?? 1;

    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");

    const where = and(eq(books.status, "organized"), eq(books.series, name));

    const [totalResult, items] = await Promise.all([
      db.select({ count: count() }).from(books).where(where),
      db
        .select(bookColumns)
        .from(books)
        .where(where)
        .orderBy(asc(books.seriesIndex))
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

    const selfHref = `${baseUrl}/opds/series/${encodeURIComponent(name)}`;
    const xml = buildFeed(
      {
        id: `urn:libris:opds:series:${encodeURIComponent(name)}`,
        title: name,
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
  });
