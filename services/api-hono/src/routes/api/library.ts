import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { HTTPException } from "hono/http-exception";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { assertPathWithinRoot } from "../../lib/assert-path-within-root.js";
import { normalizeLanguage } from "../../lib/languages.js";
import { Readable } from "node:stream";
import {
  users,
  books,
  bookColumns,
  bookFiles,
  bookMetadataCandidates,
  readingAggregate,
  readingProgress,
} from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin, requireBookOwnership } from "../../shared/auth.js";
import { resolveUploaderRef, scopeCreatedBy, uploaderRef } from "../../shared/uploader-ref.js";
import { invalidateRouteCache } from "../../services/cache.js";
import { isUniqueViolation, uniqueViolationMessage } from "../../shared/db-errors.js";
import { escapeIlike } from "../../shared/escape-ilike.js";
import { enqueueBookOrganize, enqueueUserReorganize } from "../../shared/enqueue-book-organize.js";
import {
  IdParamSchema,
  IdFileIdParamSchema,
  LibraryListQuerySchema,
  LibrarySyncQuerySchema,
} from "../../shared/validation.js";
import {
  BookListResponseSchema,
  BookDetailSchema,
  BookSyncResponseSchema,
  BookUpdatedSchema,
  BookProgressResponseSchema,
  ProgressAggregateSchema,
  RefetchResponseSchema,
  ReorganizeResponseSchema,
  FacetsResponseSchema,
  LibraryPatchBodySchema,
  ApproveBookBodySchema,
  ReadingStatusOverrideBodySchema,
} from "../../shared/schemas.js";
import {
  buildProgressAggregateForBook,
  buildProgressAggregatesForBooks,
  emptyProgressAggregate,
} from "../../lib/progress-aggregate.js";

// ── MIME type maps ──────────────────────────────────────────────────

const COVER_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const FORMAT_MIMES: Record<string, string> = {
  epub: "application/epub+zip",
};

// ── Metadata fields allowed for apply-metadata ──────────────────────

const METADATA_FIELDS = new Set([
  "title",
  "author",
  "isbn10",
  "isbn13",
  "publisher",
  "publishedYear",
  "language",
  "description",
  "coverUrl",
  "pageCount",
  "series",
  "seriesIndex",
  "genres",
  "tags",
]);

// Subset of metadata fields the organize worker writes into the EPUB itself
// (and, for title/author, that determine its on-disk location). Editing any of
// these on an organized book requires a re-organize so the file content and
// location stay in sync with the DB — otherwise the DB and the actual EPUB
// drift apart. Keep aligned with the embed call in workers/book-organize.ts.
const EPUB_EMBEDDED_FIELDS = new Set([
  "title",
  "author",
  "isbn10",
  "isbn13",
  "publisher",
  "publishedYear",
  "language",
  "description",
  "genres",
  "coverUrl",
]);

// ── Route definitions ───────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["library"],
  summary: "List library books",
  description:
    "Paginated list of organized books with optional search and filtering. The organized library is shared, so every caller sees every book together with its uploader's display label. `uploader.id` is an opaque per-install reference, never the uploader's user id; pass a value from `GET /api/library/facets` as `uploaderId` to filter. An unrecognised `uploaderId` returns an empty page.",
  request: {
    query: LibraryListQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of books with files",
      content: {
        "application/json": { schema: BookListResponseSchema },
      },
    },
  },
});

const syncRoute = createRoute({
  method: "get",
  path: "/sync",
  tags: ["library"],
  summary: "Bulk library sync feed",
  description:
    "Single paginated endpoint optimised for full-vault mirror clients and CLIs. Returns BookSyncRecord[] bundling each organised book's metadata + a per-book progress aggregate (max % across devices + derived reading status). Optional ?since=<ISO> filters to books whose metadata or progress changed after that time. `uploader.id` is an opaque per-install reference, never the uploader's user id.",
  request: {
    query: LibrarySyncQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated sync records",
      content: {
        "application/json": { schema: BookSyncResponseSchema },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["library"],
  summary: "Get library book",
  description:
    "Retrieve a single organized book with its files. `uploader.id` is an opaque per-install reference, never the uploader's user id.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Book with files",
      content: {
        "application/json": { schema: BookDetailSchema },
      },
    },
    404: { description: "Book not found" },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["library"],
  summary: "Update library book",
  description: "Edit metadata fields on an organized book",
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: LibraryPatchBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Updated book",
      content: {
        "application/json": { schema: BookUpdatedSchema },
      },
    },
    400: { description: "No valid fields to update" },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found" },
    409: { description: "Unique constraint violation (e.g. duplicate series + series index)" },
  },
});

const progressRoute = createRoute({
  method: "get",
  path: "/{id}/progress",
  tags: ["library"],
  summary: "Get reading progress for a book",
  description:
    "Returns reading progress across all devices by matching book file content hashes to KoReader document identifiers",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Reading progress entries for the book",
      content: {
        "application/json": { schema: BookProgressResponseSchema },
      },
    },
    404: { description: "Book not found" },
  },
});

const refetchRoute = createRoute({
  method: "post",
  path: "/{id}/refetch",
  tags: ["library"],
  summary: "Refetch metadata from external sources",
  description:
    "Delete existing non-file metadata candidates and re-fetch from Hardcover for an organized book. The book stays organized throughout.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Refetch enqueued",
      content: {
        "application/json": { schema: RefetchResponseSchema },
      },
    },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found or not organized" },
    422: { description: "Book has no metadata to search with" },
  },
});

const reorganizeRoute = createRoute({
  method: "post",
  path: "/{id}/reorganize",
  tags: ["library"],
  summary: "Re-organize a library book",
  description:
    "Enqueue a BOOK_ORGANIZE job for an already-organized book so its files are moved to match updated metadata (author/title)",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Reorganize job enqueued",
      content: {
        "application/json": { schema: ReorganizeResponseSchema },
      },
    },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found or not organized" },
  },
});

const facetsRoute = createRoute({
  method: "get",
  path: "/facets",
  tags: ["library"],
  summary: "Get library filter facets",
  description:
    "Returns library filter values. The organized library is shared, so every caller receives every uploader who owns an organized book. Each uploader is identified by an opaque per-install reference plus a display label — never by user id. Pass the reference back as `uploaderId` on `GET /api/library`.",
  responses: {
    200: {
      description: "Distinct authors, genres, languages, series, and uploader values",
      content: {
        "application/json": { schema: FacetsResponseSchema },
      },
    },
  },
});

const applyMetadataRoute = createRoute({
  method: "post",
  path: "/{id}/apply-metadata",
  tags: ["library"],
  summary: "Apply refetched metadata to a library book",
  description:
    "Select metadata fields from refetched candidates and apply them to an organized book. Automatically enqueues a re-organize job to update file paths and re-embed EPUB metadata.",
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: ApproveBookBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Metadata applied and re-organize job enqueued",
      content: {
        "application/json": { schema: BookUpdatedSchema },
      },
    },
    400: { description: "No valid fields provided" },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found or not organized" },
    409: { description: "Unique constraint violation (e.g. duplicate series + series index)" },
  },
});

const setReadingStatusRoute = createRoute({
  method: "patch",
  path: "/{id}/reading-status",
  tags: ["library"],
  summary: "Manually set reading status for a book",
  description:
    "Override the computed reading status with user-supplied values. Sticky against KoReader sync until the user clears the override via DELETE.",
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": { schema: ReadingStatusOverrideBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Override applied; returns the updated effective progress aggregate",
      content: {
        "application/json": { schema: ProgressAggregateSchema },
      },
    },
    400: { description: "Invalid date (future or finishedAt before startedAt)" },
    404: { description: "Book not found" },
  },
});

const clearReadingStatusRoute = createRoute({
  method: "delete",
  path: "/{id}/reading-status",
  tags: ["library"],
  summary: "Clear the manual reading status override",
  description:
    "Remove any manual override and revert to the computed reading status from KoReader sync data.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Override cleared; returns the updated effective progress aggregate",
      content: {
        "application/json": { schema: ProgressAggregateSchema },
      },
    },
    404: { description: "Book not found" },
  },
});

const libraryCoverRoute = createRoute({
  method: "get",
  path: "/{id}/cover",
  tags: ["library"],
  summary: "Get library book cover",
  description:
    "Returns the cover image for an organized book, served from the library storage path. Supports ETag-based cache revalidation.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Cover image (JPEG, PNG, WebP, or GIF)",
      content: {
        "image/jpeg": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/png": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/webp": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/gif": { schema: z.any().openapi({ type: "string", format: "binary" }) },
      },
    },
    304: { description: "Not modified (ETag matched)" },
    400: { description: "Invalid book ID" },
    404: { description: "Book not found or no cover available" },
  },
});

const libraryDownloadRoute = createRoute({
  method: "get",
  path: "/{id}/download/{fileId}",
  tags: ["library"],
  summary: "Download a book file",
  description:
    "Streams the ebook file for download, identified by book ID and file ID. Sets Content-Disposition for browser download with the original filename.",
  request: {
    params: IdFileIdParamSchema,
  },
  responses: {
    200: {
      description: "Ebook file binary stream",
      content: {
        "application/epub+zip": {
          schema: z.any().openapi({ type: "string", format: "binary" }),
        },
        "application/octet-stream": {
          schema: z.any().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    400: { description: "Invalid book ID or file ID" },
    404: { description: "Book, file, or file on disk not found" },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Uploader attribution for a book row.
 *
 * `id` is the opaque uploader reference, never `users.id` — see
 * `shared/uploader-ref.ts` for why.
 */
function formatUploader(
  row: { uploaderId: string | null; uploaderLabel: string | null },
  secret: string,
) {
  if (!row.uploaderId || !row.uploaderLabel) return null;
  return { id: uploaderRef(row.uploaderId, secret), label: row.uploaderLabel };
}

export const libraryRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  // --- GET / (list) ---
  .openapi(listRoute, async (c) => {
    const { page, limit, author, genre, language, series, uploaderId, q, sort } =
      c.req.valid("query");
    const offset = (page - 1) * limit;
    const db = c.get("db");
    const secret = c.get("env").API_SECRET_KEY;
    const userId = getUserId(c);
    const callerIsAdmin = isAdmin(c);

    // Build WHERE conditions
    const conditions = [eq(books.status, "organized")];

    if (author) {
      conditions.push(ilike(books.author, `%${escapeIlike(author)}%`));
    }

    if (series) {
      conditions.push(eq(books.series, series));
    }

    if (language) {
      conditions.push(sql`lower(${books.language}) = lower(${language})`);
    }

    if (uploaderId) {
      // uploaderId is the opaque reference handed out by /facets, not a user id.
      // An unknown reference matches nothing, so a harvested or guessed raw user
      // id cannot be replayed here as a filter.
      const resolved = await resolveUploaderRef(db, uploaderId, secret);
      conditions.push(resolved ? eq(books.createdBy, resolved) : sql`false`);
    }

    if (genre) {
      // genres is a text[] column — check if the array contains the genre (case-insensitive)
      conditions.push(
        sql`EXISTS (SELECT 1 FROM unnest(${books.genres}) g WHERE lower(g) = lower(${genre}))`,
      );
    }

    // When searching: tsquery for FTS + pg_trgm fallback for typos
    let tsquery: string | null = null;
    if (q) {
      const sanitized = q.replaceAll(/[&|!<>():*\\]/g, " ").trim();
      if (sanitized) {
        const words = sanitized.split(/\s+/).filter(Boolean);
        tsquery = words
          .map((w: string, i: number) => (i === words.length - 1 ? `${w}:*` : w))
          .join(" & ");

        conditions.push(
          sql`(
            "search_vector" @@ to_tsquery('english', ${tsquery})
            OR ${books.title} % ${q}
            OR ${books.author} % ${q}
          )`,
        );
      }
    }

    const where = and(...conditions);

    // Rank by FTS relevance when searching, otherwise use sort param
    const sortMap: Record<string, ReturnType<typeof sql>> = {
      title_asc: sql`${books.title} ASC NULLS LAST`,
      title_desc: sql`${books.title} DESC NULLS LAST`,
      author_asc: sql`${books.author} ASC NULLS LAST`,
      author_desc: sql`${books.author} DESC NULLS LAST`,
      added_newest: desc(books.createdAt),
      added_oldest: asc(books.createdAt),
      series_asc: sql`${books.series} ASC NULLS LAST, ${books.seriesIndex} ASC NULLS LAST`,
    };

    const orderBy = tsquery
      ? sql`ts_rank("search_vector", to_tsquery('english', ${tsquery})) DESC, ${books.title}`
      : (sortMap[sort] ?? sortMap.title_asc!);

    // Run count and data queries in parallel
    const [totalResult, items] = await Promise.all([
      db.select({ count: count() }).from(books).where(where),
      db
        .select({
          ...bookColumns,
          uploaderId: users.id,
          uploaderLabel: users.name,
        })
        .from(books)
        .leftJoin(users, eq(users.id, books.createdBy))
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalResult[0]?.count ?? 0;

    // Fetch files for all returned books in one query
    const bookIds = items.map((b) => b.id);
    const files =
      bookIds.length > 0
        ? await db.select().from(bookFiles).where(inArray(bookFiles.bookId, bookIds))
        : [];

    // Group files by bookId
    const filesByBook = new Map<string, (typeof files)[number][]>();
    for (const f of files) {
      const arr = filesByBook.get(f.bookId) ?? [];
      arr.push(f);
      filesByBook.set(f.bookId, arr);
    }

    return c.json(
      {
        data: items.map((book) => ({
          ...(({ uploaderId: _uploaderId, uploaderLabel: _uploaderLabel, ...rest }) => rest)(book),
          createdBy: scopeCreatedBy(book.createdBy, userId, callerIsAdmin),
          uploader: formatUploader(book, secret),
          files: (filesByBook.get(book.id) ?? []).map((f) => ({
            id: f.id,
            format: f.format,
            originalName: f.originalName,
            fileSize: f.fileSize.toString(),
          })),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      200,
    );
  })

  // --- GET /sync (bulk feed for mirror clients) ---
  // Registered before /:id so the literal path takes precedence.
  .openapi(syncRoute, async (c) => {
    const { page, limit, since } = c.req.valid("query");
    const offset = (page - 1) * limit;
    const db = c.get("db");
    const userId = getUserId(c);
    const secret = c.get("env").API_SECRET_KEY;
    const callerIsAdmin = isAdmin(c);

    const conditions = [eq(books.status, "organized")];
    if (since) {
      // Either the book's own metadata moved, or new progress was recorded for it.
      conditions.push(sql`(
        ${books.updatedAt} > ${since}
        OR EXISTS (
          SELECT 1 FROM ${readingProgress} rp
          WHERE rp.book_id = ${books.id}
          AND rp.user_id = ${userId}
          AND to_timestamp(rp.timestamp) > ${since}
        )
      )`);
    }
    const where = and(...conditions);

    const [totalResult, items] = await Promise.all([
      db.select({ count: count() }).from(books).where(where),
      db
        .select({
          ...bookColumns,
          uploaderId: users.id,
          uploaderLabel: users.name,
        })
        .from(books)
        .leftJoin(users, eq(users.id, books.createdBy))
        .where(where)
        // Ascending by updatedAt gives clients a stable, resumable cursor.
        .orderBy(asc(books.updatedAt), asc(books.id))
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalResult[0]?.count ?? 0;
    const bookIds = items.map((b) => b.id);
    const totalPages = Math.ceil(total / limit);
    const serverTime = new Date().toISOString();

    if (bookIds.length === 0) {
      return c.json({ data: [], pagination: { page, limit, total, totalPages }, serverTime }, 200);
    }

    const files = await db.select().from(bookFiles).where(inArray(bookFiles.bookId, bookIds));
    const filesByBook = new Map<string, (typeof files)[number][]>();
    for (const f of files) {
      const arr = filesByBook.get(f.bookId) ?? [];
      arr.push(f);
      filesByBook.set(f.bookId, arr);
    }

    // Fetch progress + aggregate rows for the page in two batched queries; the
    // helper picks the highest-percentage row per book and applies any manual
    // override on top. Page size caps the row count (≤ ~limit × devices), so
    // doing the reduction in JS is trivial and portable.
    const [progressRows, aggregateRows] = await Promise.all([
      db
        .select({
          bookId: readingProgress.bookId,
          percentage: readingProgress.percentage,
          device: readingProgress.device,
          timestamp: readingProgress.timestamp,
        })
        .from(readingProgress)
        .where(
          and(
            eq(readingProgress.userId, userId),
            isNotNull(readingProgress.bookId),
            inArray(readingProgress.bookId, bookIds),
          ),
        ),
      db
        .select({
          bookId: readingAggregate.bookId,
          startedAt: readingAggregate.startedAt,
          finishedAt: readingAggregate.finishedAt,
          manualStatus: readingAggregate.manualStatus,
          manualStartedAt: readingAggregate.manualStartedAt,
          manualFinishedAt: readingAggregate.manualFinishedAt,
          manualPausedAt: readingAggregate.manualPausedAt,
          manualSetAt: readingAggregate.manualSetAt,
          externalStatus: readingAggregate.externalStatus,
          externalStatusSyncedAt: readingAggregate.externalStatusSyncedAt,
        })
        .from(readingAggregate)
        .where(
          and(
            eq(readingAggregate.userId, userId),
            isNotNull(readingAggregate.bookId),
            inArray(readingAggregate.bookId, bookIds),
          ),
        ),
    ]);

    const progressByBook = buildProgressAggregatesForBooks(bookIds, progressRows, aggregateRows);

    return c.json(
      {
        data: items.map((book) => {
          const progress = progressByBook.get(book.id) ?? emptyProgressAggregate();
          return {
            ...(({ uploaderId: _u, uploaderLabel: _l, ...rest }) => rest)(book),
            createdBy: scopeCreatedBy(book.createdBy, userId, callerIsAdmin),
            uploader: formatUploader(book, secret),
            files: (filesByBook.get(book.id) ?? []).map((f) => ({
              id: f.id,
              format: f.format,
              originalName: f.originalName,
              fileSize: f.fileSize.toString(),
            })),
            progress,
          };
        }),
        pagination: { page, limit, total, totalPages },
        serverTime,
      },
      200,
    );
  })

  // --- GET /facets ---
  .openapi(facetsRoute, async (c) => {
    const db = c.get("db");
    const secret = c.get("env").API_SECRET_KEY;

    const [authorsResult, genresResult, languagesResult, seriesResult, uploadersResult] =
      await Promise.all([
        db
          .selectDistinct({ author: books.author })
          .from(books)
          .where(eq(books.status, "organized"))
          .orderBy(books.author),
        db
          .select({ genre: sql<string>`DISTINCT unnest(${books.genres})` })
          .from(books)
          .where(eq(books.status, "organized"))
          .orderBy(sql`1`),
        db
          .selectDistinct({ language: books.language })
          .from(books)
          .where(and(eq(books.status, "organized"), isNotNull(books.language)))
          .orderBy(books.language),
        db
          .selectDistinct({ series: books.series })
          .from(books)
          .where(and(eq(books.status, "organized"), isNotNull(books.series)))
          .orderBy(books.series),
        db
          .selectDistinct({ id: users.id, label: users.name })
          .from(books)
          .innerJoin(users, eq(users.id, books.createdBy))
          .where(eq(books.status, "organized"))
          .orderBy(users.name),
      ]);

    return c.json(
      {
        authors: authorsResult.map((r) => r.author).filter(Boolean) as string[],
        genres: genresResult.map((r) => r.genre).filter(Boolean) as string[],
        languages: languagesResult.map((r) => r.language).filter(Boolean) as string[],
        series: seriesResult.map((r) => r.series).filter(Boolean) as string[],
        // Opaque references, never raw user ids — the list endpoint resolves
        // them back when one is passed as ?uploaderId.
        uploaders: uploadersResult.map((u) => ({ id: uploaderRef(u.id, secret), label: u.label })),
      },
      200,
    );
  })

  // --- GET /:id ---
  .openapi(getRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const userId = getUserId(c);
    const secret = c.get("env").API_SECRET_KEY;

    const [book] = await db
      .select({
        ...bookColumns,
        uploaderId: users.id,
        uploaderLabel: users.name,
      })
      .from(books)
      .leftJoin(users, eq(users.id, books.createdBy))
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    const [files, progress] = await Promise.all([
      db.select().from(bookFiles).where(eq(bookFiles.bookId, id)),
      buildProgressAggregateForBook(db, id, userId),
    ]);

    return c.json(
      (({ uploaderId: _uploaderId, uploaderLabel: _uploaderLabel, ...rest }) => ({
        ...rest,
        createdBy: scopeCreatedBy(book.createdBy, userId, isAdmin(c)),
        uploader: formatUploader(book, secret),
        files: files.map((f) => ({
          id: f.id,
          format: f.format,
          originalName: f.originalName,
          storagePath: f.storagePath,
          fileSize: f.fileSize.toString(),
          checksum: f.checksum,
        })),
        progress,
      }))(book),
      200,
    );
  })

  // --- PATCH /:id ---
  .openapi(patchRoute, async (c) => {
    const { id } = c.req.valid("param");
    const updates = c.req.valid("json");
    const db = c.get("db");
    const queues = c.get("queues");
    const cacheStorage = c.get("cacheStorage");

    if (Object.keys(updates).length === 0) {
      throw new HTTPException(400, { message: "No valid fields to update" });
    }

    // Keep language canonical regardless of what the client sends (falls back
    // to the raw value when unrecognized so nothing is silently dropped).
    if ("language" in updates && updates.language != null) {
      updates.language = normalizeLanguage(updates.language) ?? updates.language;
    }

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    // Verify book exists and is organized
    const [existing] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!existing) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    let updated;
    try {
      [updated] = await db
        .update(books)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(books.id, id))
        // `bookColumns`, not a bare `.returning()`: the bare form returns every
        // column, `search_vector` included, which BookUpdatedSchema does not
        // declare and no client can use (libris-dnx). Both sides of the
        // contract now derive from the same list — see the drift test in
        // shared/schemas.test.ts.
        .returning(bookColumns);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, { message: uniqueViolationMessage(err) });
      }
      throw err;
    }

    // Re-organize when any field embedded into the EPUB (or affecting its
    // on-disk path) changed, so the file content/location stays in sync with
    // the DB — not only when the cover changed. Force a cover re-download only
    // when the cover URL itself was updated.
    const coverChanged = "coverUrl" in updates;
    const needsReorganize = Object.keys(updates).some((field) => EPUB_EMBEDDED_FIELDS.has(field));
    if (needsReorganize) {
      await enqueueBookOrganize(queues.bookOrganize, {
        bookId: id,
        forceRedownloadCover: coverChanged,
      });
    }

    // Title, author, series, language and genres are all rendered into the OPDS
    // feeds, and genres feed the /api/stats distribution. `/api/library` itself
    // is not cached, so it needs no invalidation.
    await invalidateRouteCache(cacheStorage, "/opds", "/api/stats");

    return c.json(updated, 200);
  })

  // --- GET /:id/progress ---
  .openapi(progressRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");

    // Verify book exists and is organized
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    // Get content hashes for this book's files
    const files = await db
      .select({ contentHash: bookFiles.contentHash })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    const hashes = files.map((f) => f.contentHash).filter((h): h is string => h != null);

    if (hashes.length === 0) {
      return c.json({ bookId: id, progress: [] }, 200);
    }

    // Join reading_progress via content hash match
    const userId = getUserId(c);
    const progress = await db
      .select({
        document: readingProgress.document,
        device: readingProgress.device,
        deviceId: readingProgress.deviceId,
        progress: readingProgress.progress,
        percentage: readingProgress.percentage,
        timestamp: readingProgress.timestamp,
      })
      .from(readingProgress)
      .innerJoin(
        bookFiles,
        or(
          eq(readingProgress.document, bookFiles.contentHash),
          eq(readingProgress.document, bookFiles.originalContentHash),
        ),
      )
      .where(and(eq(bookFiles.bookId, id), eq(readingProgress.userId, userId)))
      .orderBy(desc(readingProgress.timestamp));

    return c.json(
      {
        bookId: id,
        progress: progress.map((p) => ({
          document: p.document,
          device: p.device,
          deviceId: p.deviceId ?? undefined,
          progress: p.progress,
          percentage: Number(p.percentage),
          timestamp: Number(p.timestamp),
        })),
      },
      200,
    );
  })

  // --- POST /:id/refetch ---
  .openapi(refetchRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const queues = c.get("queues");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    const [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found or not in organized status" });
    }

    // Build search query from existing book metadata (prefer ISBN, fall back to title/author)
    let searchQuery = "";
    if (book.isbn13) {
      searchQuery = `isbn:${book.isbn13}`;
    } else if (book.isbn10) {
      searchQuery = `isbn:${book.isbn10}`;
    } else if (book.title) {
      searchQuery = book.author ? `${book.title} by ${book.author}` : book.title;
    }

    if (!searchQuery) {
      throw new HTTPException(422, { message: "Book has no metadata to build a search query" });
    }

    // Delete existing non-file candidates so the refetch starts fresh
    await db
      .delete(bookMetadataCandidates)
      .where(and(eq(bookMetadataCandidates.bookId, id), ne(bookMetadataCandidates.source, "file")));

    // Enqueue metadata fetch job with skipStatusChange to keep the book organized
    await queues.bookFetchMetadata.add("fetch-metadata", {
      bookId: id,
      searchQuery,
      skipStatusChange: true,
    });

    // No invalidation: this deletes candidates and enqueues a refetch, and the
    // candidates endpoint is not cached. The book row itself is untouched, so
    // the OPDS feeds still describe it correctly. (The worker's later write is
    // the worker's to invalidate — see cache.ts.)

    return c.json({ status: "refetching" as const, bookId: id, searchQuery }, 200);
  })

  // --- POST /:id/reorganize ---
  .openapi(reorganizeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const queues = c.get("queues");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    // Verify book exists and is organized
    const [book] = await db
      .select({ id: books.id, status: books.status })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found or not in organized status" });
    }

    // Enqueue organize job — the worker handles re-organize when inboxPath is null
    await enqueueUserReorganize(queues.bookOrganize, id, getUserId(c));

    // No invalidation: nothing this handler changes is visible in a cached
    // response. A re-organize moves files on disk, but OPDS acquisition links
    // address them by bookFiles.id, which the move does not change.

    return c.json({ message: "Reorganize job enqueued" as const, bookId: id }, 200);
  })

  // --- POST /:id/apply-metadata ---
  .openapi(applyMetadataRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("db");
    const queues = c.get("queues");
    const cacheStorage = c.get("cacheStorage");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    // Verify book exists and is organized
    const [book] = await db
      .select({ id: books.id, status: books.status })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found or not in organized status" });
    }

    // Fetch all candidates for source-to-id mapping
    const allCandidates = await db
      .select({ id: bookMetadataCandidates.id, source: bookMetadataCandidates.source })
      .from(bookMetadataCandidates)
      .where(eq(bookMetadataCandidates.bookId, id));

    // Build the update from selected fields
    const bookUpdates: Record<string, unknown> = {};
    const candidateSelections = new Map<string, string[]>();

    for (const [fieldName, selected] of Object.entries(body.fields)) {
      if (!METADATA_FIELDS.has(fieldName)) continue;

      bookUpdates[fieldName] = selected.value;

      // Track which candidate was selected for each field (skip "manual" and "current" entries)
      if (selected.source !== "manual" && selected.source !== "current") {
        const match = allCandidates.find((candidate) => candidate.source === selected.source);
        if (match) {
          const existing = candidateSelections.get(match.id) || [];
          existing.push(fieldName);
          candidateSelections.set(match.id, existing);
        }
      }
    }

    if (Object.keys(bookUpdates).length === 0) {
      throw new HTTPException(400, { message: "No valid fields provided" });
    }

    // Keep language canonical regardless of the selected candidate's value.
    if (typeof bookUpdates.language === "string") {
      bookUpdates.language = normalizeLanguage(bookUpdates.language) ?? bookUpdates.language;
    }

    // Update book and candidate selections atomically
    bookUpdates.updatedAt = new Date();

    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        const [result] = await tx
          .update(books)
          .set(bookUpdates)
          .where(eq(books.id, id))
          // Same contract as PATCH /{id} above — BookUpdatedSchema, so
          // bookColumns (libris-dnx).
          .returning(bookColumns);

        for (const [candidateId, fields] of candidateSelections) {
          await tx
            .update(bookMetadataCandidates)
            .set({ selectedFields: fields })
            .where(eq(bookMetadataCandidates.id, candidateId));
        }

        return result;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, { message: uniqueViolationMessage(err) });
      }
      throw err;
    }

    // Enqueue re-organize job to move files and re-embed EPUB metadata
    const coverUrlChanged = "coverUrl" in bookUpdates;
    await enqueueBookOrganize(queues.bookOrganize, {
      bookId: id,
      forceRedownloadCover: coverUrlChanged,
    });

    // Applying a candidate rewrites the same fields the OPDS feeds render, and
    // the genres behind /api/stats.
    await invalidateRouteCache(cacheStorage, "/opds", "/api/stats");

    return c.json(updated, 200);
  })

  // --- PATCH /:id/reading-status ---
  .openapi(setReadingStatusRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("db");
    const cacheStorage = c.get("cacheStorage");
    const userId = getUserId(c);

    const now = new Date();
    const startedAt = body.startedAt ? new Date(body.startedAt) : null;
    const finishedAt = body.finishedAt ? new Date(body.finishedAt) : null;
    const pausedAt = body.pausedAt ? new Date(body.pausedAt) : null;

    for (const [name, value] of [
      ["startedAt", startedAt],
      ["finishedAt", finishedAt],
      ["pausedAt", pausedAt],
    ] as const) {
      if (value && value.getTime() > now.getTime()) {
        throw new HTTPException(400, { message: `${name} cannot be in the future` });
      }
    }

    if (startedAt && finishedAt && finishedAt.getTime() < startedAt.getTime()) {
      throw new HTTPException(400, { message: "finishedAt cannot be before startedAt" });
    }

    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));
    if (!book) throw new HTTPException(404, { message: "Book not found" });

    // Per-status field policy: unread clears all dates; reading keeps only startedAt;
    // finished keeps started+finished; paused keeps started+pausedAt.
    let manualStartedAt: Date | null = null;
    let manualFinishedAt: Date | null = null;
    let manualPausedAt: Date | null = null;
    if (body.status === "reading") {
      manualStartedAt = startedAt;
    } else if (body.status === "finished") {
      manualStartedAt = startedAt;
      manualFinishedAt = finishedAt;
    } else if (body.status === "paused") {
      manualStartedAt = startedAt;
      manualPausedAt = pausedAt;
    }

    await db
      .insert(readingAggregate)
      .values({
        userId,
        bookId: id,
        manualStatus: body.status,
        manualStartedAt,
        manualFinishedAt,
        manualPausedAt,
        manualSetAt: now,
      })
      .onConflictDoUpdate({
        target: [readingAggregate.userId, readingAggregate.bookId],
        set: {
          manualStatus: body.status,
          manualStartedAt,
          manualFinishedAt,
          manualPausedAt,
          manualSetAt: now,
          updatedAt: now,
        },
      });

    const aggregate = await buildProgressAggregateForBook(db, id, userId);

    // A manual reading status feeds the finished counts and streaks on
    // /api/stats, whose cache key is per user. The OPDS feeds carry no reading
    // state, and neither /api/library nor /api/reading-status is cached.
    await invalidateRouteCache(cacheStorage, "/api/stats");

    return c.json(aggregate, 200);
  })

  // --- DELETE /:id/reading-status ---
  .openapi(clearReadingStatusRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const cacheStorage = c.get("cacheStorage");
    const userId = getUserId(c);

    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));
    if (!book) throw new HTTPException(404, { message: "Book not found" });

    await db
      .update(readingAggregate)
      .set({
        manualStatus: null,
        manualStartedAt: null,
        manualFinishedAt: null,
        manualPausedAt: null,
        manualSetAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(readingAggregate.userId, userId), eq(readingAggregate.bookId, id)));

    const aggregate = await buildProgressAggregateForBook(db, id, userId);

    // A manual reading status feeds the finished counts and streaks on
    // /api/stats, whose cache key is per user. The OPDS feeds carry no reading
    // state, and neither /api/library nor /api/reading-status is cached.
    await invalidateRouteCache(cacheStorage, "/api/stats");

    return c.json(aggregate, 200);
  })

  // --- GET /:id/cover ---
  .openapi(libraryCoverRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const env = c.get("env");

    const [book] = await db
      .select({ coverPath: books.coverPath })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    if (!book.coverPath) {
      throw new HTTPException(404, { message: "No cover image available" });
    }

    const libraryRoot = realpathSync(env.LIBRIS_LIBRARY_PATH);
    const fullPath = resolve(join(libraryRoot, book.coverPath));

    assertPathWithinRoot(fullPath, libraryRoot);

    if (!existsSync(fullPath)) {
      throw new HTTPException(404, { message: "Cover file not found on disk" });
    }

    const fileStat = await stat(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const contentType = COVER_MIME_TYPES[ext] || "application/octet-stream";

    // ETag based on mtime + size for cache revalidation when covers change
    const etag = `W/"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
        ETag: etag,
      },
    });
  })

  // --- GET /:id/download/:fileId ---
  .openapi(libraryDownloadRoute, async (c) => {
    const { id, fileId } = c.req.valid("param");
    const db = c.get("db");
    const env = c.get("env");

    // Verify book exists and is organized
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    // Find the file belonging to this book
    const [file] = await db
      .select()
      .from(bookFiles)
      .where(and(eq(bookFiles.id, fileId), eq(bookFiles.bookId, id)));

    if (!file) {
      throw new HTTPException(404, { message: "File not found" });
    }

    if (!file.storagePath) {
      throw new HTTPException(404, { message: "File not available for download" });
    }

    const libraryRoot = realpathSync(env.LIBRIS_LIBRARY_PATH);
    const fullPath = resolve(join(libraryRoot, file.storagePath));

    assertPathWithinRoot(fullPath, libraryRoot);

    if (!existsSync(fullPath)) {
      throw new HTTPException(404, { message: "File not found on disk" });
    }

    const fileStat = await stat(fullPath);
    const contentType = FORMAT_MIMES[file.format] || "application/octet-stream";
    const fileName = file.originalName || basename(fullPath);

    const encodedFileName = encodeURIComponent(fileName)
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29");

    const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
      },
    });
  });
