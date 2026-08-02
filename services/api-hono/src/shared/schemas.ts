/**
 * Shared OpenAPI-annotated response schemas built from drizzle-orm/zod base schemas.
 *
 * Import `z` from `@hono/zod-openapi` so `.openapi()` is available on every
 * schema produced here.  The drizzle-orm/zod schemas use plain `zod`, so we
 * re-wrap their `.shape` through the OpenAPI-aware `z.object()` where needed.
 */
import { z } from "@hono/zod-openapi";
import {
  BookSelectSchema,
  BookFileSelectSchema,
  BookMetadataCandidateSelectSchema,
  BookUpdateSchema,
} from "#db";

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Re-wrap a drizzle-orm/zod schema's shape through the OpenAPI-aware `z` so
 * `.pick()` / `.extend()` / `.openapi()` all work.
 */
const wrap = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => z.object(schema.shape as T);

// ── Base schemas (re-wrapped for OpenAPI compat) ─────────────────────

const BookBase = wrap(BookSelectSchema).omit({ searchVector: true });
const BookFileBase = wrap(BookFileSelectSchema);
const CandidateBase = wrap(BookMetadataCandidateSelectSchema);

// ── Book file schemas ────────────────────────────────────────────────

export const BookFileSchema = BookFileBase.pick({
  id: true,
  format: true,
  originalName: true,
})
  .extend({
    // fileSize is bigint in DB but serialized as string over JSON
    fileSize: z.string(),
  })
  .openapi("BookFile");

export const BookFileDetailSchema = BookFileSchema.extend({
  storagePath: z.string().nullable(),
  checksum: z.string().nullable(),
}).openapi("BookFileDetail");

export const UploaderSummarySchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
  })
  .openapi("UploaderSummary");

export const InboxDetailFileSchema = BookFileSchema.extend({
  inboxPath: z.string().nullable().optional(),
  checksum: z.string().nullable().optional(),
}).openapi("InboxDetailFile");

// ── Book summary / detail schemas ────────────────────────────────────

export const BookSummarySchema = BookBase.extend({
  // Override fileSize-derived fields and add the files relation
  files: z.array(BookFileSchema),
  uploader: UploaderSummarySchema.nullable(),
}).openapi("BookSummary");

/** Aggregate progress for a book — the MAX(percentage) row across devices. */
export const ProgressAggregateSchema = z
  .object({
    /** 0–1 fraction; null when no progress recorded yet. */
    percentage: z.number().nullable(),
    /** "unread" | "reading" | "paused" | "finished" — manual override wins over computed. */
    status: z.enum(["unread", "reading", "paused", "finished"]).nullable(),
    /** Device that last pushed the highest-percentage entry. */
    lastDevice: z.string().nullable(),
    /** Unix seconds of the highest-percentage entry. */
    lastTimestamp: z.number().nullable(),
    /** ISO 8601 — manual override or earliest sync. */
    startedAt: z.string().datetime().nullable(),
    /** ISO 8601 — manual override or first finished sync. */
    finishedAt: z.string().datetime().nullable(),
    /** ISO 8601 — manual-only; null when status was never overridden to paused. */
    pausedAt: z.string().datetime().nullable(),
    /** True when the user has manually set the status. UI uses this to expose a Clear-override action. */
    manuallySet: z.boolean(),
    /** True when the effective status came from external_status (Hardcover-pulled) and there is no manual override or local progress. UI uses this to label the source. */
    externallySet: z.boolean(),
  })
  .openapi("ProgressAggregate");

export const ReadingStatusOverrideBodySchema = z
  .object({
    status: z.enum(["unread", "reading", "finished", "paused"]),
    startedAt: z.string().datetime().nullable().optional(),
    finishedAt: z.string().datetime().nullable().optional(),
    pausedAt: z.string().datetime().nullable().optional(),
  })
  .openapi("ReadingStatusOverrideBody");

export const BookDetailSchema = BookBase.extend({
  files: z.array(BookFileDetailSchema),
  uploader: UploaderSummarySchema.nullable(),
  progress: ProgressAggregateSchema,
}).openapi("BookDetail");

/** The shape returned after PATCH / apply-metadata (full book row, no files). */
export const BookUpdatedSchema = BookBase.openapi("BookUpdated");

// ── Pagination ───────────────────────────────────────────────────────

export const PaginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi("Pagination");

export const BookListResponseSchema = z
  .object({
    data: z.array(BookSummarySchema),
    pagination: PaginationSchema,
  })
  .openapi("BookListResponse");

// ── Progress ─────────────────────────────────────────────────────────

export const ProgressEntrySchema = z
  .object({
    document: z.string(),
    device: z.string(),
    deviceId: z.string().optional(),
    progress: z.string(),
    percentage: z.number(),
    timestamp: z.number(),
  })
  .openapi("ProgressEntry");

export const BookProgressResponseSchema = z
  .object({
    bookId: z.string().uuid(),
    progress: z.array(ProgressEntrySchema),
  })
  .openapi("BookProgressResponse");

// ── Bulk sync record (full-vault mirror / CLI consumers) ───────────────

/**
 * Single record returned by `GET /api/library/sync`.
 *
 * `BookSummary` already carries every metadata field a mirror client needs
 * (description, files, uploader, …); this just adds the per-book progress
 * aggregate so a sync run is one paginated drain instead of N×3 requests.
 * Cover bytes are still served by `/api/library/{id}/cover` — clients refetch
 * conditionally based on `book.updatedAt`.
 */
export const BookSyncRecordSchema = BookSummarySchema.extend({
  progress: ProgressAggregateSchema,
}).openapi("BookSyncRecord");

export const BookSyncResponseSchema = z
  .object({
    data: z.array(BookSyncRecordSchema),
    pagination: PaginationSchema,
    /** Server time when this response was generated; clients persist for next ?since. */
    serverTime: z.string().datetime(),
  })
  .openapi("BookSyncResponse");

// ── Library action responses ─────────────────────────────────────────

export const RefetchResponseSchema = z
  .object({
    status: z.string(),
    bookId: z.string().uuid(),
    searchQuery: z.string(),
  })
  .openapi("RefetchResponse");

export const ReorganizeResponseSchema = z
  .object({
    message: z.string(),
    bookId: z.string().uuid(),
  })
  .openapi("ReorganizeResponse");

export const FacetsResponseSchema = z
  .object({
    authors: z.array(z.string()),
    genres: z.array(z.string()),
    languages: z.array(z.string()),
    series: z.array(z.string()),
    uploaders: z.array(UploaderSummarySchema),
  })
  .openapi("FacetsResponse");

// ── Approve / apply-metadata body ────────────────────────────────────

const ApprovedFieldSchema = z.object({
  source: z.string().max(100),
  value: z.union([z.string(), z.number(), z.array(z.string()), z.boolean(), z.null()]),
});

export const ApproveBookBodySchema = z
  .object({
    fields: z.record(z.string().max(100), ApprovedFieldSchema),
  })
  .openapi("ApproveBookBody");

// ── Library patch body (derived from DB update schema) ───────────────

export const LibraryPatchBodySchema = wrap(BookUpdateSchema)
  .pick({
    title: true,
    author: true,
    isbn10: true,
    isbn13: true,
    publisher: true,
    publishedYear: true,
    language: true,
    description: true,
    pageCount: true,
    series: true,
    seriesIndex: true,
    genres: true,
    tags: true,
    coverUrl: true,
  })
  .openapi("LibraryPatchBody");

// ── Auth schemas ─────────────────────────────────────────────────────
//
export const ApiKeyDeletedSchema = z
  .object({
    deleted: z.boolean(),
    id: z.string().uuid(),
  })
  .openapi("ApiKeyDeleted");

// ── Inbox schemas ────────────────────────────────────────────────────

export const InboxListItemSchema = BookBase.extend({
  files: z.array(BookFileSchema),
  uploader: UploaderSummarySchema.nullable(),
}).openapi("InboxListItem");

export const InboxListResponseSchema = z
  .object({
    data: z.array(InboxListItemSchema),
    pagination: PaginationSchema,
  })
  .openapi("InboxListResponse");

export const InboxCandidateSchema = CandidateBase.pick({
  id: true,
  source: true,
  normalized: true,
  confidence: true,
  selectedFields: true,
}).openapi("InboxCandidate");

export const HardcoverSearchResultSchema = CandidateBase.pick({
  source: true,
  normalized: true,
})
  .extend({
    confidence: z.number(),
  })
  .openapi("HardcoverSearchResult");

export const HardcoverSearchResponseSchema = z
  .object({
    results: z.array(HardcoverSearchResultSchema),
  })
  .openapi("HardcoverSearchResponse");

export const PossibleDuplicateSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    status: z.string(),
  })
  .openapi("PossibleDuplicate");

export const InboxDetailResponseSchema = BookBase.extend({
  possibleDuplicate: PossibleDuplicateSchema.nullable(),
  files: z.array(InboxDetailFileSchema),
  candidates: z.array(InboxCandidateSchema),
  uploader: UploaderSummarySchema.nullable(),
}).openapi("InboxDetailResponse");

export const InboxCountResponseSchema = z
  .object({
    count: z.number().int(),
  })
  .openapi("InboxCountResponse");

export const ProcessingStageSchema = z
  .object({
    stage: z.string(),
    label: z.string(),
  })
  .openapi("ProcessingStage");

export const ProcessingResponseSchema = z
  .object({
    processing: z.record(z.string(), ProcessingStageSchema),
  })
  .openapi("ProcessingResponse");

export const RescanResponseSchema = z
  .object({
    status: z.string(),
    bookId: z.string().uuid(),
    searchQuery: z.string(),
  })
  .openapi("RescanResponse");

export const UploadedFileSchema = z
  .object({
    filename: z.string(),
    size: z.number().int(),
  })
  .openapi("UploadedFile");

export const UploadErrorSchema = z
  .object({
    filename: z.string(),
    error: z.string(),
  })
  .openapi("UploadError");

export const UploadResponseSchema = z
  .object({
    uploaded: z.array(UploadedFileSchema),
    errors: z.array(UploadErrorSchema),
  })
  .openapi("UploadResponse");

// ── Credential schemas ───────────────────────────────────────────────

export const CredentialStatusSchema = z
  .object({
    configured: z.boolean(),
    service: z.string(),
    username: z.string().optional(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().nullable().optional(),
  })
  .openapi("CredentialStatus");

export const CredentialUpdatedSchema = z
  .object({
    service: z.string(),
    username: z.string(),
    updated: z.boolean(),
  })
  .openapi("CredentialUpdated");

export const CredentialDeletedSchema = z
  .object({
    service: z.string(),
    deleted: z.boolean(),
  })
  .openapi("CredentialDeleted");

// ── Books (approve / candidates) schemas ─────────────────────────────

export const BookApprovedResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: z.string(),
    title: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    genres: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.coerce.date().optional(),
    updatedAt: z.coerce.date().optional(),
  })
  .openapi("BookApprovedResponse");

export const BookCandidatesResponseSchema = z
  .object({
    book: z.object({
      id: z.string().uuid(),
      status: z.string(),
      title: z.string().nullable(),
      author: z.string().nullable(),
    }),
    candidates: z.array(
      CandidateBase.pick({
        id: true,
        source: true,
        normalized: true,
        confidence: true,
        selectedFields: true,
      }),
    ),
  })
  .openapi("BookCandidatesResponse");

// ── Reading status schemas ───────────────────────────────────────────

export const ReadingStatusCountsSchema = z
  .object({
    unread: z.number().int(),
    reading: z.number().int(),
    finished: z.number().int(),
    paused: z.number().int(),
  })
  .openapi("ReadingStatusCounts");

export const ReadingStatusBookSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    coverPath: z.string().nullable(),
    isbn13: z.string().nullable(),
    isbn10: z.string().nullable(),
    genres: z.array(z.string()),
    pageCount: z.number().int().nullable(),
    percentage: z.number().nullable(),
    device: z.string().nullable(),
    lastReadAt: z.coerce.date().nullable(),
    readingStatus: z.enum(["unread", "reading", "finished", "paused"]),
  })
  .openapi("ReadingStatusBook");

export const ReadingStatusListResponseSchema = z
  .object({
    data: z.array(ReadingStatusBookSchema),
    pagination: PaginationSchema,
  })
  .openapi("ReadingStatusListResponse");
