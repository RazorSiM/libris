import { createRoute } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { books, bookColumns, bookFiles, bookMetadataCandidates } from "#db";
import type { AppVariables } from "../../context.js";
import { normalizeLanguage } from "../../lib/languages.js";
import { requireBookOwnership } from "../../shared/auth.js";
import { invalidateRouteCache } from "../../services/cache.js";
import { enqueueBookOrganize } from "../../shared/enqueue-book-organize.js";
import { isUniqueViolation, uniqueViolationMessage } from "../../shared/db-errors.js";
import { IdParamSchema } from "../../shared/validation.js";
import {
  ApproveBookBodySchema,
  BookUpdatedSchema,
  BookCandidatesResponseSchema,
} from "../../shared/schemas.js";

import { getLogger } from "../../lib/logger.js";

const logger = getLogger("books:delete");

// ── DELETE /{id} ─────────────────────────────────────────────────

const deleteBookRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["books"],
  summary: "Delete book",
  description: "Delete a book and its associated files from the database and disk",
  request: {
    params: IdParamSchema,
  },
  responses: {
    204: { description: "Book deleted" },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found" },
  },
});

// ── POST /{id}/approve ───────────────────────────────────────────

const approveRoute = createRoute({
  method: "post",
  path: "/{id}/approve",
  tags: ["books"],
  summary: "Approve book metadata",
  description:
    "Select metadata fields from candidates, mark book as organized, and enqueue file organization",
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: ApproveBookBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Book approved and organize job enqueued",
      content: {
        "application/json": {
          // The updated book row, same shape PATCH /api/library/{id} returns.
          // This used to declare a seven-field summary while the handler's bare
          // `.returning()` answered with the entire row — so the response
          // carried `search_vector`, and the fields callers actually read off
          // it (isbn13, publisher, language, approvedAt) were undocumented
          // (libris-dnx).
          schema: BookUpdatedSchema,
        },
      },
    },
    400: { description: "No valid fields provided" },
    403: { description: "Not authorized to modify this book" },
    404: { description: "Book not found" },
    409: { description: "Book is not in review status" },
  },
});

// ── GET /{id}/candidates ─────────────────────────────────────────

const candidatesRoute = createRoute({
  method: "get",
  path: "/{id}/candidates",
  tags: ["books"],
  summary: "Get metadata candidates",
  description: "List metadata candidates fetched from external sources for a book",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Book info with metadata candidates",
      content: {
        "application/json": {
          schema: BookCandidatesResponseSchema,
        },
      },
    },
    403: { description: "Not authorized to view this book" },
    404: { description: "Book not found" },
  },
});

// ── Constants ────────────────────────────────────────────────────

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

// ── Router ───────────────────────────────────────────────────────

export const booksRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(deleteBookRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const env = c.get("env");
    const cacheStorage = c.get("cacheStorage");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    const [book] = await db
      .select({ id: books.id, status: books.status })
      .from(books)
      .where(eq(books.id, id));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    // Collect file paths before deleting from DB
    const files = await db
      .select({ inboxPath: bookFiles.inboxPath, storagePath: bookFiles.storagePath })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, id));

    // Delete DB record first (cascade removes book_files and candidates)
    await db.delete(books).where(eq(books.id, id));

    const libraryPath = env.LIBRIS_LIBRARY_PATH;

    // Best-effort file cleanup — orphan cleanup task catches any failures
    for (const file of files) {
      // inboxPath is absolute; storagePath is relative to libraryPath
      const path =
        file.inboxPath ?? (file.storagePath ? join(libraryPath, file.storagePath) : null);
      if (path) {
        unlink(path).catch((err) =>
          logger.withMetadata({ error: String(err) }).warn(`Failed to delete file ${path}`),
        );
      }
    }

    // The book is gone from every OPDS feed that listed it, and from the genre
    // counts on /api/stats. Nothing else the API serves is cached.
    await invalidateRouteCache(cacheStorage, "/opds", "/api/stats");

    return c.body(null, 204);
  })
  .openapi(approveRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("db");
    const queues = c.get("queues");
    const cacheStorage = c.get("cacheStorage");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, id));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    // Fetch all candidates once for source-to-id mapping
    const allCandidates = await db
      .select({ id: bookMetadataCandidates.id, source: bookMetadataCandidates.source })
      .from(bookMetadataCandidates)
      .where(eq(bookMetadataCandidates.bookId, id));

    // Build the update from approved fields
    const bookUpdates: Record<string, unknown> = {};
    const candidateSelections = new Map<string, string[]>();

    for (const [fieldName, approved] of Object.entries(body.fields)) {
      if (!METADATA_FIELDS.has(fieldName)) continue;

      bookUpdates[fieldName] = approved.value;

      // Track which candidate was selected for each field (skip "manual" entries)
      if (approved.source !== "manual") {
        const match = allCandidates.find((candidate) => candidate.source === approved.source);
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

    // Keep language canonical regardless of the approved candidate's value
    // (defense-in-depth; file candidates are normalized at extraction and the
    // review picker uses a select, but the approve body is client-supplied).
    if (typeof bookUpdates.language === "string") {
      bookUpdates.language = normalizeLanguage(bookUpdates.language) ?? bookUpdates.language;
    }

    // Update book and candidates atomically
    bookUpdates.status = "organized";
    bookUpdates.approvedAt = new Date();
    bookUpdates.updatedAt = new Date();

    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        const [result] = await tx
          .update(books)
          .set(bookUpdates)
          .where(and(eq(books.id, id), eq(books.status, "review")))
          // `bookColumns` — the list BookUpdatedSchema above is derived from,
          // so the query and the declared response are two views of one thing
          // (libris-dnx).
          .returning(bookColumns);

        if (!result) {
          const [currentBook] = await tx
            .select({ status: books.status })
            .from(books)
            .where(eq(books.id, id))
            .limit(1);

          throw new HTTPException(409, {
            message: `Book is in '${currentBook?.status ?? "unknown"}' status, expected 'review'`,
          });
        }

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

    // Enqueue organize job AFTER transaction commits successfully
    await enqueueBookOrganize(queues.bookOrganize, { bookId: id });

    // The transaction already set status to "organized", so the book is in the
    // OPDS catalogue as of now — that is exactly the feed an e-reader refreshes
    // right after an approval, so it must not keep serving the pre-approval
    // copy. Its genres also move the /api/stats distribution.
    await invalidateRouteCache(cacheStorage, "/opds", "/api/stats");

    return c.json(updated, 200);
  })
  .openapi(candidatesRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");

    // Ownership check (owner or admin)
    await requireBookOwnership(c, db, id);

    // Verify book exists
    const [book] = await db
      .select({ id: books.id, status: books.status, title: books.title, author: books.author })
      .from(books)
      .where(eq(books.id, id));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    const candidates = await db
      .select()
      .from(bookMetadataCandidates)
      .where(eq(bookMetadataCandidates.bookId, id));

    return c.json(
      {
        book: {
          id: book.id,
          status: book.status,
          title: book.title,
          author: book.author,
        },
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          source: candidate.source,
          normalized: candidate.normalized,
          confidence: candidate.confidence,
          selectedFields: candidate.selectedFields,
        })),
      },
      200,
    );
  });
