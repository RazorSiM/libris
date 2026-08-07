import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { eq, and, count, sql, inArray, isNotNull } from "drizzle-orm";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { languageLabel } from "../../lib/languages.js";
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

const listLanguagesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "List languages (OPDS)",
  description:
    "Returns an OPDS navigation feed listing only the languages present in organized books (canonical ISO 639-1 codes shown as full names), each linking to a language-specific acquisition feed.",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  responses: {
    200: {
      description: "OPDS navigation feed of languages (Atom XML)",
      content: {
        [OPDS_MIME_NAVIGATION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

const languageBooksRoute = createRoute({
  method: "get",
  path: "/{code}",
  tags: ["opds"],
  summary: "Books by language (OPDS)",
  description:
    "Returns a paginated OPDS acquisition feed of books in a specific language, identified by its ISO 639-1 code (case-insensitive).",
  middleware: [cachedRoute({ maxAge: 120 })] as const,
  request: {
    params: z.object({
      code: z.string().min(1).max(35).openapi({ description: "Language code, e.g. 'en'" }),
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
      description: "OPDS acquisition feed of books in the language (Atom XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsLanguagesRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(listLanguagesRoute, async (c) => {
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");
    const now = new Date();

    // Distinct languages (with counts) actually present in organized books —
    // never the full ISO 639-1 list.
    const rows = await db
      .select({
        language: books.language,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(books)
      .where(and(eq(books.status, "organized"), isNotNull(books.language)))
      .groupBy(books.language)
      .orderBy(books.language);

    const entries = rows.map((row) => {
      const code = row.language as string;
      return navigationEntry({
        id: `urn:libris:opds:languages:${code}`,
        title: languageLabel(code),
        updated: now,
        content: `${row.count} book${row.count === 1 ? "" : "s"}`,
        link: {
          rel: "subsection",
          href: `${baseUrl}/opds/languages/${encodeURIComponent(code)}`,
          type: OPDS_MIME_ACQUISITION,
        },
      });
    });

    const xml = buildFeed(
      {
        id: "urn:libris:opds:languages",
        title: "Languages",
        updated: now,
        selfHref: `${baseUrl}/opds/languages`,
        selfType: OPDS_MIME_NAVIGATION,
        startHref: `${baseUrl}/opds`,
      },
      entries,
    );

    return new Response(xml, {
      headers: { "Content-Type": OPDS_MIME_NAVIGATION },
    });
  })

  .openapi(languageBooksRoute, async (c) => {
    const { code } = c.req.valid("param");
    const { page: rawPage } = c.req.valid("query");
    const page = rawPage ?? 1;

    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    const db = c.get("db");

    // Case-insensitive match, mirroring the library list filter.
    const where = and(
      eq(books.status, "organized"),
      sql`lower(${books.language}) = lower(${code})`,
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

    const selfHref = `${baseUrl}/opds/languages/${encodeURIComponent(code)}`;
    const xml = buildFeed(
      {
        id: `urn:libris:opds:languages:${code}`,
        title: languageLabel(code),
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
