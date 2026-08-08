import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { HTTPException } from "hono/http-exception";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { access } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { basename, join, extname, resolve } from "node:path";
import { users, books, bookColumns, bookFiles, bookMetadataCandidates, uploadRegistry } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin, requireBookOwnership } from "../../shared/auth.js";
import { uploaderRef } from "../../shared/uploader-ref.js";
import { extractEpubCoverImage } from "../../lib/metadata/index.js";
import { fetchExternalImage } from "../../shared/secure-image-fetch.js";
import { validateEpubUpload } from "../../shared/epub-validation.js";

import { getLogger } from "../../lib/logger.js";

const coverLogger = getLogger("inbox:cover");

const COVER_PROXY_TIMEOUT_MS = 10_000;
import { computeChecksumFromBuffer } from "../../shared/checksum.js";
import { InboxListQuerySchema, IdParamSchema } from "../../shared/validation.js";
import {
  InboxListResponseSchema,
  InboxDetailResponseSchema,
  InboxCountResponseSchema,
  ProcessingResponseSchema,
  RescanResponseSchema,
  UploadResponseSchema,
} from "../../shared/schemas.js";

// ── Constants ────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".epub"]);
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Per-file skip reason when the same bytes are already on the server.
 *
 * Names neither the owner nor the status of the existing copy: the caller
 * supplied these bytes, so the only thing disclosed is that they are already
 * here. That is the price of not silently swallowing the upload.
 */
const DUPLICATE_UPLOAD_MESSAGE = "This file has already been uploaded to this library";

function isPathWithinDirectory(filePath: string, rootPath: string): boolean {
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

async function writeInboxFile(
  inboxPath: string,
  originalName: string,
  buffer: Uint8Array,
): Promise<{ storedName: string; destPath: string }> {
  const safeName = basename(originalName);
  const extension = extname(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length) || "upload";
  const resolvedInboxPath = resolve(inboxPath);

  for (let attempt = 0; ; attempt++) {
    const storedName = attempt === 0 ? safeName : `${stem}-${attempt}${extension}`;
    const destPath = resolve(join(resolvedInboxPath, storedName));

    if (!isPathWithinDirectory(destPath, resolvedInboxPath)) {
      throw new HTTPException(400, { message: "Invalid filename" });
    }

    try {
      await writeFile(destPath, buffer, { flag: "wx" });
      return { storedName, destPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }

      throw error;
    }
  }
}

/** Guess MIME type from image buffer magic bytes. */
function detectMimeType(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  return "application/octet-stream";
}

// ── Route definitions ────────────────────────────────────────────────

/**
 * Uploader attribution for a book row. `id` is the opaque uploader reference,
 * never `users.id` — see `shared/uploader-ref.ts`.
 */
function formatUploader(
  row: { uploaderId: string | null; uploaderLabel: string | null },
  secret: string,
) {
  if (!row.uploaderId || !row.uploaderLabel) return null;
  return { id: uploaderRef(row.uploaderId, secret), label: row.uploaderLabel };
}

const listInboxRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["inbox"],
  summary: "List inbox books",
  description:
    "Paginated list of books in inbox or review status. Non-admin users see only books they own.",
  request: {
    query: InboxListQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of inbox books with files",
      content: {
        "application/json": { schema: InboxListResponseSchema },
      },
    },
  },
});

const getInboxBookRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["inbox"],
  summary: "Get inbox book",
  description:
    "Retrieve an owned inbox/review book with its files and metadata candidates. Admins may retrieve any book.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Book with files and candidates",
      content: {
        "application/json": { schema: InboxDetailResponseSchema },
      },
    },
    403: { description: "Not authorized to view this book" },
    404: { description: "Book not found" },
  },
});

const inboxCountRoute = createRoute({
  method: "get",
  path: "/count",
  tags: ["inbox"],
  summary: "Get inbox count",
  description:
    "Returns the number of visible books in inbox or review status. Non-admin counts are owner-scoped.",
  responses: {
    200: {
      description: "Inbox count",
      content: {
        "application/json": { schema: InboxCountResponseSchema },
      },
    },
  },
});

const inboxProcessingRoute = createRoute({
  method: "get",
  path: "/processing",
  tags: ["inbox"],
  summary: "Inbox processing status",
  description:
    "Returns the current pipeline stage for visible books being processed. Non-admin results are owner-scoped.",
  responses: {
    200: {
      description: "Map of bookId to processing stage",
      content: {
        "application/json": { schema: ProcessingResponseSchema },
      },
    },
  },
});

const rescanRoute = createRoute({
  method: "patch",
  path: "/{id}/rescan",
  tags: ["inbox"],
  summary: "Rescan inbox book metadata",
  description: "Delete existing metadata candidates and re-fetch from external sources",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Rescan enqueued",
      content: {
        "application/json": { schema: RescanResponseSchema },
      },
    },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found" },
    422: { description: "Book has no metadata to search with" },
  },
});

const inboxCoverRoute = createRoute({
  method: "get",
  path: "/{id}/cover",
  tags: ["inbox"],
  summary: "Get inbox book cover",
  description:
    "Returns the cover image for an owned inbox/review book. Admins may retrieve any cover. Tries EPUB extraction first, then falls back to proxying the coverUrl from metadata sources.",
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
    400: { description: "Invalid book ID" },
    403: { description: "Not authorized to view this book" },
    404: { description: "Book not found or no cover available" },
  },
});

const uploadRoute = createRoute({
  method: "post",
  path: "/upload",
  tags: ["inbox"],
  summary: "Upload ebook files",
  description:
    "Upload one or more ebook files (EPUB) to the inbox directory. Files are saved to disk; the file watcher picks them up for processing.\n\nThe response splits the batch three ways. `uploaded[]` is what was written. `skipped[]` is files whose contents are already on the server — already ingested, or uploaded by anyone and still awaiting the watcher; ingestion deduplicates by checksum, so writing them would drop them silently, and they are not written. A skip is **not** a failure: the library already holds that book, which is what the caller wanted. `errors[]` is genuine rejections — unsupported format, over the size limit, not a readable EPUB, or an unsafe filename.\n\nThe status is 400 only when every file landed in `errors[]`. A batch that was entirely skipped is 200: nothing was wrong with the request, there was simply nothing left to do.",
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z
              .union([
                z.any().openapi({ type: "string", format: "binary" }),
                z.array(z.any().openapi({ type: "string", format: "binary" })),
              ])
              .openapi({ description: "One or more ebook files" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Per-file outcome for the batch: `uploaded[]`, `skipped[]` (already in the library), `errors[]`. Returned whenever at least one file was written or skipped, even if others errored.",
      content: {
        "application/json": { schema: UploadResponseSchema },
      },
    },
    400: {
      description:
        "No files provided, or every file in the batch failed. A batch where every file was skipped as already-present is 200, not 400.",
    },
  },
});

// ── Handlers ─────────────────────────────────────────────────────────

export const inboxRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  // GET / — list inbox books
  .openapi(listInboxRoute, async (c) => {
    const { page, limit, q, sort } = c.req.valid("query");
    const offset = (page - 1) * limit;
    const db = c.get("db");
    const secret = c.get("env").API_SECRET_KEY;

    // Inbox shows books with status 'inbox' or 'review'
    const conditions = [inArray(books.status, ["inbox", "review"])];
    if (!isAdmin(c)) conditions.push(eq(books.createdBy, getUserId(c)));

    // When searching: tsquery for FTS + pg_trgm fallback for typos/filenames
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

    // Sort map for inbox
    const sortMap: Record<string, ReturnType<typeof sql>> = {
      title_asc: sql`${books.title} ASC NULLS LAST`,
      title_desc: sql`${books.title} DESC NULLS LAST`,
      detected_newest: sql`${books.createdAt} DESC`,
      detected_oldest: sql`${books.createdAt} ASC`,
      status_asc: sql`${books.status} ASC, ${books.createdAt} DESC`,
      status_desc: sql`${books.status} DESC, ${books.createdAt} DESC`,
    };

    // Rank by FTS relevance when searching, otherwise use sort param
    const orderBy = tsquery
      ? sql`ts_rank("search_vector", to_tsquery('english', ${tsquery})) DESC, ${books.createdAt} DESC`
      : (sortMap[sort] ?? sortMap.detected_newest!);

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
    const filesByBook = new Map<string, typeof files>();
    for (const f of files) {
      const arr = filesByBook.get(f.bookId) ?? [];
      arr.push(f);
      filesByBook.set(f.bookId, arr);
    }

    return c.json({
      data: items.map((book) => ({
        ...(({ uploaderId: _uploaderId, uploaderLabel: _uploaderLabel, ...rest }) => rest)(book),
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
    });
  })

  // GET /count — inbox count
  .openapi(inboxCountRoute, async (c) => {
    const db = c.get("db");
    const where = isAdmin(c)
      ? inArray(books.status, ["inbox", "review"])
      : and(inArray(books.status, ["inbox", "review"]), eq(books.createdBy, getUserId(c)));

    const result = await db.select({ count: count() }).from(books).where(where);

    return c.json({ count: result[0]?.count ?? 0 });
  })

  // GET /processing — processing status
  .openapi(inboxProcessingRoute, async (c) => {
    const db = c.get("db");
    const queues = c.get("queues");
    const processing: Record<string, { stage: string; label: string }> = {};

    const stages = [
      { queue: queues.bookParseFile, stage: "parsing", label: "Parsing file..." },
      { queue: queues.bookFetchMetadata, stage: "fetching", label: "Fetching metadata..." },
      { queue: queues.bookOrganize, stage: "organizing", label: "Organizing..." },
    ] as const;

    try {
      await Promise.all(
        stages.map(async ({ queue, stage, label }) => {
          // BullMQ Queue objects expose getJobs at runtime; the minimal
          // Queues interface only declares `add`, so we cast here.
          const getJobs = (queue as unknown as Record<string, unknown>).getJobs as
            | ((states: string[]) => Promise<{ data?: { bookId?: string } }[]>)
            | undefined;
          if (!getJobs) return;

          const jobs = await getJobs.call(queue, ["active", "waiting", "delayed"]);
          for (const job of jobs) {
            if (job.data?.bookId) {
              processing[job.data.bookId] = { stage, label };
            }
          }
        }),
      );
    } catch {
      // Redis may be unavailable — return empty map gracefully
    }

    if (!isAdmin(c) && Object.keys(processing).length > 0) {
      const owned = await db
        .select({ id: books.id })
        .from(books)
        .where(and(inArray(books.id, Object.keys(processing)), eq(books.createdBy, getUserId(c))));
      const ownedIds = new Set(owned.map(({ id }) => id));
      for (const id of Object.keys(processing)) {
        if (!ownedIds.has(id)) delete processing[id];
      }
    }

    return c.json({ processing });
  })

  // GET /:id — single inbox book
  .openapi(getInboxBookRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const secret = c.get("env").API_SECRET_KEY;

    const [book] = await db
      .select({
        ...bookColumns,
        uploaderId: users.id,
        uploaderLabel: users.name,
      })
      .from(books)
      .leftJoin(users, eq(users.id, books.createdBy))
      .where(and(eq(books.id, id), inArray(books.status, ["inbox", "review"])));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    await requireBookOwnership(c, db, id);

    const [files, candidates] = await Promise.all([
      db.select().from(bookFiles).where(eq(bookFiles.bookId, id)),
      db.select().from(bookMetadataCandidates).where(eq(bookMetadataCandidates.bookId, id)),
    ]);

    // If this book has a possible duplicate, fetch the duplicate's basic info
    let possibleDuplicate: {
      id: string;
      title: string | null;
      author: string | null;
      status: string;
    } | null = null;
    if (book.possibleDuplicateOf) {
      const [dup] = await db
        .select({ id: books.id, title: books.title, author: books.author, status: books.status })
        .from(books)
        .where(eq(books.id, book.possibleDuplicateOf));
      if (dup) {
        possibleDuplicate = dup;
      }
    }

    return c.json({
      ...(({ uploaderId: _uploaderId, uploaderLabel: _uploaderLabel, ...rest }) => rest)(book),
      uploader: formatUploader(book, secret),
      possibleDuplicate,
      files: files.map((f) => ({
        id: f.id,
        format: f.format,
        originalName: f.originalName,
        fileSize: f.fileSize.toString(),
        checksum: f.checksum,
      })),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        source: candidate.source,
        normalized: candidate.normalized,
        confidence: candidate.confidence,
        selectedFields: candidate.selectedFields,
      })),
    });
  })

  // PATCH /:id/rescan — rescan metadata
  .openapi(rescanRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const queues = c.get("queues");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    const [book] = await db
      .select()
      .from(books)
      .where(and(eq(books.id, id), inArray(books.status, ["inbox", "review"])));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
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

    // Delete old candidates and reset status atomically so we never end up
    // with candidates deleted but the book still in "review", or vice-versa.
    await db.transaction(async (tx) => {
      await tx
        .delete(bookMetadataCandidates)
        .where(
          and(eq(bookMetadataCandidates.bookId, id), ne(bookMetadataCandidates.source, "file")),
        );

      await tx
        .update(books)
        .set({ status: "inbox", updatedAt: new Date() })
        .where(eq(books.id, id));
    });

    // Enqueue metadata fetch job AFTER the transaction commits successfully
    await queues.bookFetchMetadata.add("fetch-metadata", { bookId: id, searchQuery });

    // No invalidation: a rescan moves the book between "review" and "inbox",
    // and neither status appears in the OPDS catalogue (organized only) or in
    // the /api/stats aggregates. The inbox and candidates endpoints it used to
    // name are not cached at all.

    return c.json({ status: "rescanning", bookId: id, searchQuery });
  })

  // GET /:id/cover — cover image
  // Tries EPUB extraction first, then falls back to proxying coverUrl.
  .openapi(inboxCoverRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");

    await requireBookOwnership(c, db, id);

    // Verify book exists and is in inbox/review status
    const [book] = await db
      .select({ id: books.id, coverUrl: books.coverUrl })
      .from(books)
      .where(and(eq(books.id, id), inArray(books.status, ["inbox", "review"])));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    // 1. Try EPUB extraction first
    const [epubFile] = await db
      .select({ inboxPath: bookFiles.inboxPath })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, id), eq(bookFiles.format, "epub")));

    if (epubFile?.inboxPath) {
      coverLogger.debug(`Book ${id}: trying EPUB extraction from ${epubFile.inboxPath}`);

      let fileAccessible = true;
      try {
        await access(epubFile.inboxPath);
      } catch {
        coverLogger.warn(`Book ${id}: EPUB file not readable at ${epubFile.inboxPath}`);
        fileAccessible = false;
      }

      if (fileAccessible) {
        const coverBuffer = await extractEpubCoverImage(epubFile.inboxPath);
        if (coverBuffer && coverBuffer.length > 0) {
          coverLogger.debug(`Book ${id}: EPUB cover extracted, ${coverBuffer.length} bytes`);
          return new Response(new Uint8Array(coverBuffer), {
            headers: {
              "Content-Type": detectMimeType(coverBuffer),
              "Content-Length": String(coverBuffer.length),
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, max-age=3600",
            },
          });
        }
        coverLogger.debug(
          `Book ${id}: EPUB extraction returned no cover, trying coverUrl fallback`,
        );
      }
    }

    // 2. Fall back to proxying coverUrl from metadata sources
    if (book.coverUrl) {
      coverLogger.debug(`Book ${id}: proxying cover from ${book.coverUrl}`);
      try {
        const image = await fetchExternalImage(book.coverUrl, {
          timeoutMs: COVER_PROXY_TIMEOUT_MS,
          allowedOrigins: c.get("env").LIBRIS_COVER_FETCH_ALLOWLIST,
        });
        return new Response(new Uint8Array(image.data), {
          headers: {
            "Content-Type": image.contentType,
            "Content-Length": String(image.data.length),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        coverLogger.withMetadata({ error: String(err) }).warn(`Book ${id}: cover proxy error`);
        throw new HTTPException(404, { message: "Failed to proxy cover image" });
      }
    }

    coverLogger.debug(`Book ${id}: no cover source available (no EPUB extraction, no coverUrl)`);
    throw new HTTPException(404, { message: "No cover image available" });
  })

  // POST /upload — file upload
  .openapi(uploadRoute, async (c) => {
    const env = c.get("env");
    const body = await c.req.parseBody({ all: true });
    const rawFiles = body["file"];

    // Normalize to array
    const fileEntries: File[] = [];
    if (Array.isArray(rawFiles)) {
      for (const f of rawFiles) {
        if (f instanceof File && f.name !== "") fileEntries.push(f);
      }
    } else if (rawFiles instanceof File && rawFiles.name !== "") {
      fileEntries.push(rawFiles);
    }

    if (fileEntries.length === 0) {
      throw new HTTPException(400, { message: "No files provided" });
    }

    const inboxPath = env.LIBRIS_INBOX_PATH;
    const uploaded: { filename: string; size: number }[] = [];
    const skipped: { filename: string; reason: string }[] = [];
    const errors: { filename: string; error: string }[] = [];

    for (const file of fileEntries) {
      const ext = extname(file.name).toLowerCase();

      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        errors.push({
          filename: file.name,
          error: `Unsupported format: ${ext}. Supported: epub`,
        });
        continue;
      }

      if (file.size > MAX_FILE_SIZE) {
        errors.push({
          filename: file.name,
          error: `File exceeds 100MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
        });
        continue;
      }

      const buffer = new Uint8Array(await file.arrayBuffer());
      const epubError = validateEpubUpload(buffer);
      if (epubError) {
        errors.push({ filename: file.name, error: epubError });
        continue;
      }
      const safeName = basename(file.name);
      const checksum = computeChecksumFromBuffer(buffer);
      const db = c.get("db");

      // Ingestion deduplicates by checksum: the book-detected worker returns
      // early when any book already holds these bytes. Writing the file anyway
      // returned 200 with nothing to show for it — the book stayed in the first
      // uploader's inbox, which a second uploader cannot see now that the inbox
      // is owner-scoped, and their copy sat in the inbox directory forever.
      // Detect it here and say so instead.
      //
      // Both tables have to be checked: book_files covers everything already
      // ingested, upload_registry covers an upload still waiting on the
      // watcher, which is the window the two-user race lives in.
      const [ingested, pending] = await Promise.all([
        db
          .select({ id: bookFiles.id })
          .from(bookFiles)
          .where(eq(bookFiles.checksum, checksum))
          .limit(1),
        db
          .select({ id: uploadRegistry.id })
          .from(uploadRegistry)
          .where(eq(uploadRegistry.checksum, checksum))
          .limit(1),
      ]);

      if (ingested.length > 0 || pending.length > 0) {
        // Reported as a skip, not an error. Nothing went wrong: the caller
        // wanted this book in the library and the library already has it. Only
        // a client that conflates the two would call this a failure.
        //
        // The reason says nothing about who holds the existing copy or what
        // state it is in. The caller supplied these bytes, so all this admits
        // is that the same bytes are already here.
        skipped.push({ filename: file.name, reason: DUPLICATE_UPLOAD_MESSAGE });
        continue;
      }

      let storedName: string;
      try {
        ({ storedName } = await writeInboxFile(inboxPath, safeName, buffer));
      } catch (error) {
        if (error instanceof HTTPException && error.status === 400) {
          errors.push({ filename: file.name, error: error.message });
          continue;
        }

        throw error;
      }

      // Register the upload with its checksum so the book-detected worker can
      // attribute ownership. The name recorded is the name ON DISK, not the one
      // the browser sent: a collision renames the file, and the worker matches
      // registry rows against the file it is actually ingesting.
      const userId = c.get("userId");
      if (userId) {
        await db
          .insert(uploadRegistry)
          .values({
            checksum,
            userId,
            filename: storedName,
          })
          .onConflictDoNothing();
      }

      uploaded.push({ filename: file.name, size: file.size });
    }

    // 400 only when the whole batch genuinely failed. A batch that produced
    // nothing but skips is a successful no-op — every file the caller asked for
    // is in the library, which is the outcome they were after — so it gets a
    // 200 whose body says so. Making it a 400 would be telling the user their
    // request was malformed when it was merely redundant.
    if (uploaded.length === 0 && skipped.length === 0 && errors.length > 0) {
      throw new HTTPException(400, {
        message: `All files rejected: ${errors.map((e) => `${e.filename}: ${e.error}`).join("; ")}`,
      });
    }

    return c.json({ uploaded, skipped, errors });
  });
