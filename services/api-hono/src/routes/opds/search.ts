import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, count, sql, inArray } from "drizzle-orm";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import {
  buildFeed,
  paginationLinks,
  OPDS_MIME_ACQUISITION,
  OPDS_MIME_OPENSEARCH,
  escapeXml,
} from "../../shared/opds-xml.js";
import { getBaseUrl, OPDS_PER_PAGE, bookToEntry } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const searchRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["opds"],
  summary: "Search books or get OpenSearch descriptor (OPDS)",
  description:
    "When called with a `q` query parameter, returns a paginated OPDS acquisition feed of matching books using full-text search. Without `q`, returns an OpenSearch description document that OPDS clients use for search discovery.",
  request: {
    query: z.object({
      q: z
        .string()
        .max(500)
        .optional()
        .openapi({ description: "Search query. Omit to get the OpenSearch description document." }),
      page: z.coerce.number().int().min(1).optional().openapi({
        description: "Page number (1-based, only used with q)",
        example: 1,
      }),
    }),
  },
  responses: {
    200: {
      description:
        "OPDS acquisition feed of search results (Atom XML) or OpenSearch description (XML)",
      content: {
        [OPDS_MIME_ACQUISITION]: {
          schema: z.string().openapi({ type: "string" }),
        },
        [OPDS_MIME_OPENSEARCH]: {
          schema: z.string().openapi({ type: "string" }),
        },
      },
    },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsSearchRoutes = new OpenAPIHono<{ Variables: AppVariables }>().openapi(
  searchRoute,
  async (c) => {
    const { q: rawQ, page: rawPage } = c.req.valid("query");
    const q = rawQ?.trim() ?? "";
    const page = rawPage ?? 1;
    const baseUrl = getBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));

    // No query -- return OpenSearch description document
    if (!q) {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
        "  <ShortName>Libris</ShortName>",
        "  <Description>Search the Libris catalog</Description>",
        "  <InputEncoding>UTF-8</InputEncoding>",
        "  <OutputEncoding>UTF-8</OutputEncoding>",
        `  <Url type="${OPDS_MIME_ACQUISITION}" template="${escapeXml(baseUrl)}/opds/search?q={searchTerms}&amp;page={startPage?}"/>`,
        "</OpenSearchDescription>",
      ].join("\n");

      return new Response(xml, {
        headers: { "Content-Type": OPDS_MIME_OPENSEARCH },
      });
    }

    // Query present -- return search results acquisition feed
    const db = c.get("db");
    const perPage = OPDS_PER_PAGE;
    const offset = (page - 1) * perPage;

    // Build tsquery for FTS (no pg_trgm fallback -- e-reader keyboards are less typo-prone)
    let tsquery: string | null = null;
    const sanitized = q.replaceAll(/[&|!<>():*\\]/g, " ").trim();
    if (sanitized) {
      const words = sanitized.split(/\s+/).filter(Boolean);
      tsquery = words
        .map((w: string, i: number) => (i === words.length - 1 ? `${w}:*` : w))
        .join(" & ");
    }

    const conditions = [eq(books.status, "organized")];
    if (tsquery) {
      conditions.push(sql`"search_vector" @@ to_tsquery('english', ${tsquery})`);
    }
    const where = and(...conditions);

    // Rank by FTS relevance when searching, fall back to title alphabetical
    const orderBy = tsquery
      ? sql`ts_rank("search_vector", to_tsquery('english', ${tsquery})) DESC, ${books.title}`
      : sql`${books.title}`;

    const [totalResult, items] = await Promise.all([
      db.select({ count: count() }).from(books).where(where),
      db
        .select(bookColumns)
        .from(books)
        .where(where)
        .orderBy(orderBy)
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

    const selfHref = `${baseUrl}/opds/search?q=${encodeURIComponent(q)}`;
    const xml = buildFeed(
      {
        id: `urn:libris:opds:search:${q}`,
        title: `Search: ${q}`,
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
