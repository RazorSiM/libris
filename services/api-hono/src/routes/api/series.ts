import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, asc, count, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { books, bookColumns, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { escapeIlike } from "../../shared/escape-ilike.js";
import { BookFileSchema } from "../../shared/schemas.js";

// ── Schemas ─────────────────────────────────────────────────────

const SeriesItemSchema = z
  .object({
    name: z.string(),
    bookCount: z.number().int(),
    coverUrl: z.string().nullable(),
    coverPath: z.string().nullable(),
    coverBookId: z.string().nullable(),
  })
  .openapi("SeriesItem");

const SeriesListResponseSchema = z
  .object({
    data: z.array(SeriesItemSchema),
    total: z.number().int(),
  })
  .openapi("SeriesListResponse");

const SeriesDetailBookSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    series: z.string().nullable(),
    seriesIndex: z.number().nullable(),
    coverUrl: z.string().nullable(),
    coverPath: z.string().nullable(),
    genres: z.array(z.string()),
    tags: z.array(z.string()),
    pageCount: z.number().int().nullable(),
    publishedYear: z.number().int().nullable(),
    files: z.array(BookFileSchema),
  })
  .openapi("SeriesDetailBook");

const SeriesDetailResponseSchema = z
  .object({
    series: z.string(),
    books: z.array(SeriesDetailBookSchema),
    total: z.number().int(),
  })
  .openapi("SeriesDetailResponse");

// ── Route definitions ───────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["series"],
  summary: "List all series",
  description:
    "Returns distinct series names with book counts and cover art. Supports search filtering.",
  request: {
    query: z.object({
      q: z
        .string()
        .max(500)
        .trim()
        .optional()
        .default("")
        .openapi({ description: "Filter series names (partial match)", default: "" }),
    }),
  },
  responses: {
    200: {
      description: "Series list",
      content: { "application/json": { schema: SeriesListResponseSchema } },
    },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/{name}",
  tags: ["series"],
  summary: "Get books in a series",
  description: "Returns all books in the given series ordered by series_index (nulls last).",
  request: {
    params: z.object({
      name: z.string().openapi({ description: "Series name" }),
    }),
  },
  responses: {
    200: {
      description: "Series detail with books",
      content: { "application/json": { schema: SeriesDetailResponseSchema } },
    },
    404: { description: "Series not found" },
  },
});

// ── Router ──────────────────────────────────────────────────────

export const seriesRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(listRoute, async (c) => {
    const { q } = c.req.valid("query");
    const db = c.get("db");

    const conditions = [eq(books.status, "organized"), isNotNull(books.series)];
    if (q) {
      conditions.push(ilike(books.series, `%${escapeIlike(q)}%`));
    }

    const rows = await db
      .select({
        name: books.series,
        bookCount: count(books.id),
        coverUrl: sql<string | null>`first_cover.cover_url`,
        coverPath: sql<string | null>`first_cover.cover_path`,
        coverBookId: sql<string | null>`first_cover.id`,
      })
      .from(books)
      .leftJoin(
        sql`lateral (select id, cover_url, cover_path from books b2 where b2.series = books.series and b2.status = 'organized' order by b2.series_index nulls last, b2.created_at limit 1) as first_cover`,
        sql`true`,
      )
      .where(and(...conditions))
      .groupBy(
        books.series,
        sql`first_cover.cover_url`,
        sql`first_cover.cover_path`,
        sql`first_cover.id`,
      )
      .orderBy(asc(books.series));

    const data = rows
      .filter((r): r is typeof r & { name: string } => r.name !== null)
      .map((r) => ({
        name: r.name,
        bookCount: r.bookCount,
        coverUrl: r.coverUrl,
        coverPath: r.coverPath,
        coverBookId: r.coverBookId,
      }));

    return c.json({ data, total: data.length }, 200);
  })

  .openapi(detailRoute, async (c) => {
    const { name } = c.req.valid("param");
    const db = c.get("db");

    const seriesBooks = await db
      .select(bookColumns)
      .from(books)
      .where(and(eq(books.status, "organized"), eq(books.series, name)))
      .orderBy(asc(books.seriesIndex));

    if (seriesBooks.length === 0) {
      return c.json({ series: name, books: [], total: 0 }, 200);
    }

    // Fetch files for all matched books
    const bookIds = seriesBooks.map((b) => b.id);
    const files = await db
      .select({
        id: bookFiles.id,
        bookId: bookFiles.bookId,
        format: bookFiles.format,
        originalName: bookFiles.originalName,
        fileSize: bookFiles.fileSize,
      })
      .from(bookFiles)
      .where(inArray(bookFiles.bookId, bookIds));

    const filesByBook = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByBook.get(f.bookId) ?? [];
      arr.push(f);
      filesByBook.set(f.bookId, arr);
    }

    const booksWithFiles = seriesBooks.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      series: b.series,
      seriesIndex: b.seriesIndex,
      coverUrl: b.coverUrl,
      coverPath: b.coverPath,
      genres: b.genres,
      tags: b.tags,
      pageCount: b.pageCount,
      publishedYear: b.publishedYear,
      files: (filesByBook.get(b.id) ?? []).map((f) => ({
        id: f.id,
        format: f.format,
        originalName: f.originalName,
        fileSize: String(f.fileSize),
      })),
    }));

    return c.json({ series: name, books: booksWithFiles, total: booksWithFiles.length }, 200);
  });
