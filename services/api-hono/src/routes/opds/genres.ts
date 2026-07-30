import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, count, sql, inArray } from "drizzle-orm";
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
import { getBaseUrl, slugifyGenre, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const listGenresRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "List genres (OPDS)",
  description:
    "Returns an OPDS navigation feed listing all genres found in organized books, each linking to a genre-specific acquisition feed.",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  responses: {
    200: {
      description: "OPDS navigation feed of genres (Atom XML)",
      content: {
        [OPDS_MIME_NAVIGATION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

const genreBooksRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["opds"],
  summary: "Books by genre (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of books in a specific genre, identified by a URL-friendly slug.",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  request: {
    params: z.object({
      slug: z.string().min(1).max(500).openapi({ description: "URL-friendly genre slug" }),
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
      description: "OPDS acquisition feed of books in the genre (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsGenresRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(listGenresRoute, async (c) => {
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");
    const now = new Date();

    // Get distinct genres with book counts from organized books
    const rows = await db
      .select({
        genre: sql<string>`unnest(${books.genres})`.as("genre"),
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(books)
      .where(eq(books.status, "organized"))
      .groupBy(sql`genre`)
      .orderBy(sql`genre`);

    const entries = rows.map((row) => {
      const slug = slugifyGenre(row.genre);
      return navigationEntry({
        id: `urn:libris:opds:genres:${slug}`,
        title: row.genre,
        updated: now,
        content: `${row.count} book${row.count === 1 ? "" : "s"}`,
        link: {
          rel: "subsection",
          href: `${baseUrl}/opds/genres/${encodeURIComponent(slug)}`,
          type: OPDS_MIME_ACQUISITION,
        },
      });
    });

    const xml = buildFeed(
      {
        id: "urn:libris:opds:genres",
        title: "Genres",
        updated: now,
        selfHref: `${baseUrl}/opds/genres`,
        selfType: OPDS_MIME_NAVIGATION,
        startHref: `${baseUrl}/opds`,
      },
      entries,
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_NAVIGATION },
    });
  })

  .openapi(genreBooksRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const { page: rawPage } = c.req.valid("query");
    const page = rawPage ?? 1;

    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");

    // Match slug against slugified genre names in the array
    const where = and(
      eq(books.status, "organized"),
      sql`EXISTS (SELECT 1 FROM unnest(${books.genres}) AS g WHERE lower(regexp_replace(regexp_replace(g, '\\s+', '-', 'g'), '[^a-z0-9-]', '', 'gi')) = ${slug})`,
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

    // Derive display name from the first matching genre, or de-slug the param
    let genreName = slug.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    for (const book of items) {
      const match = book.genres.find((g) => slugifyGenre(g) === slug);
      if (match) {
        genreName = match;
        break;
      }
    }

    const selfHref = `${baseUrl}/opds/genres/${encodeURIComponent(slug)}`;
    const xml = buildFeed(
      {
        id: `urn:libris:opds:genres:${slug}`,
        title: genreName,
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
