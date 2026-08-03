import { z } from "@hono/zod-openapi";

// === Shared param schemas ===

const uuid = z.string().uuid();

export const IdParamSchema = z
  .object({
    id: uuid.openapi({ description: "Book UUID" }),
  })
  .openapi("IdParam");

export const IdFileIdParamSchema = z
  .object({
    id: uuid.openapi({ description: "Book UUID" }),
    fileId: uuid.openapi({ description: "File UUID" }),
  })
  .openapi("IdFileIdParam");

export const FileIdParamSchema = z
  .object({
    fileId: uuid.openapi({ description: "File UUID" }),
  })
  .openapi("FileIdParam");

// === Query schemas ===

const pageParam = z.coerce
  .number()
  .int()
  .min(1)
  .optional()
  .default(1)
  .openapi({ type: "integer", minimum: 1, default: 1 });
const limitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .default(20)
  .openapi({ type: "integer", minimum: 1, maximum: 100, default: 20 });
const searchString = z
  .string()
  .max(500)
  .trim()
  .optional()
  .default("")
  .openapi({ type: "string", maxLength: 500, default: "" });

const librarySortParam = z
  .enum([
    "title_asc",
    "title_desc",
    "author_asc",
    "author_desc",
    "added_newest",
    "added_oldest",
    "series_asc",
  ])
  .optional()
  .default("title_asc")
  .openapi({ type: "string", default: "title_asc" });

const inboxSortParam = z
  .enum([
    "title_asc",
    "title_desc",
    "detected_newest",
    "detected_oldest",
    "status_asc",
    "status_desc",
  ])
  .optional()
  .default("detected_newest")
  .openapi({ type: "string", default: "detected_newest" });

export const LibraryListQuerySchema = z.object({
  page: pageParam.openapi({ description: "Page number" }),
  limit: limitParam.openapi({ description: "Items per page" }),
  author: searchString.openapi({ description: "Filter by author (partial match)" }),
  genre: searchString.openapi({
    description: "Filter by genre (exact, case-insensitive)",
  }),
  language: searchString.openapi({
    description: "Filter by language code (exact, case-insensitive)",
  }),
  series: searchString.openapi({ description: "Filter by series name (exact match)" }),
  uploaderId: z
    .string()
    .trim()
    .optional()
    .default("")
    .openapi({ description: "Filter by uploader API key ID (exact match)", default: "" }),
  q: searchString.openapi({
    description: "Full-text search across title, author, and description with typo tolerance",
  }),
  sort: librarySortParam.openapi({ description: "Sort order for results" }),
});

export const LibrarySyncQuerySchema = z.object({
  page: pageParam.openapi({ description: "Page number" }),
  limit: limitParam.openapi({ description: "Items per page" }),
  since: z.string().datetime().optional().openapi({
    description:
      "ISO 8601 timestamp. When set, only return books whose metadata or progress changed after this time. Pass `serverTime` from the previous successful response.",
  }),
});

export const InboxListQuerySchema = z.object({
  page: pageParam.openapi({ description: "Page number" }),
  limit: limitParam.openapi({ description: "Items per page" }),
  q: searchString.openapi({ description: "Full-text search query" }),
  sort: inboxSortParam.openapi({ description: "Sort order for results" }),
});

export const SearchSuggestQuerySchema = z.object({
  q: z.string().max(500).trim().min(1, "q is required"),
});

// === Reading status schemas ===

export const ReadingStatusParamSchema = z.object({
  status: z.enum(["unread", "reading", "finished", "paused"]).openapi({
    description: "Reading status to filter by",
  }),
});

const readingStatusSortParam = z
  .enum(["title", "author", "percentage", "lastRead"])
  .optional()
  .default("title")
  .openapi({ type: "string", default: "title" });

export const ReadingStatusListQuerySchema = z.object({
  page: pageParam.openapi({ description: "Page number (1-based)" }),
  limit: limitParam.openapi({ description: "Number of items per page" }),
  sort: readingStatusSortParam.openapi({ description: "Sort field" }),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .default("asc")
    .openapi({ type: "string", default: "asc", description: "Sort direction" }),
  search: searchString.openapi({ description: "Full-text search query" }),
});

// === Body schemas ===

export const AuthSetupBodySchema = z.object({
  label: z
    .string()
    .max(100)
    .trim()
    .optional()
    .openapi({ description: "Optional label for the key" }),
});

export const AuthKeysCreateBodySchema = z.object({
  label: z
    .string()
    .max(100)
    .trim()
    .min(1, "label is required")
    .openapi({ description: "Human-readable label for the key" }),
});

export const SettingsPatchBodySchema = z.object({
  libraryPath: z.string().max(4096).trim().min(1).optional(),
  inboxPath: z.string().max(4096).trim().min(1).optional(),
});

// === Credential schemas ===

export const CredentialServiceParamSchema = z.object({
  // No "opds": OPDS clients authenticate with app passwords now
  // (/api/app-passwords), not with a row in service_credentials.
  service: z.enum(["kosync", "hardcover"]).openapi({
    description: "Service name",
  }),
});

export const CredentialPutBodySchema = z.object({
  username: z.string().max(200).trim().min(1, "username is required"),
  password: z
    .string()
    .max(4096)
    .min(12, "password must be at least 12 characters")
    .openapi({ description: "KoSync password or Hardcover API token (minimum 12 characters)" }),
});
