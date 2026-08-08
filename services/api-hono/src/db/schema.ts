import { getColumns, sql } from "drizzle-orm";
import {
  bigint,
  customType,
  foreignKey,
  index,
  integer,
  uniqueIndex,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { NormalizedMetadata } from "../types/book.js";

// Better Auth's tables live in their own file so upgrade diffs stay contained,
// but are re-exported here so `import * as schema` (and therefore drizzle-kit,
// the Drizzle adapter and defineRelations) sees one complete schema.
export * from "./auth-schema.js";
// `export *` does not bind names locally, and the tables below reference
// users.id directly, so it is also imported.
import { users } from "./auth-schema.js";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const bookStatusEnum = pgEnum("book_status", ["inbox", "review", "organized"]);

export const readingStatusEnum = pgEnum("reading_status", [
  "unread",
  "reading",
  "finished",
  "paused",
]);

// ── Books ───────────────────────────────────────────────────────────

export const books = pgTable(
  "books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: bookStatusEnum("status").notNull().default("inbox"),
    title: text("title"),
    author: text("author"),
    isbn10: text("isbn_10"),
    isbn13: text("isbn_13"),
    publisher: text("publisher"),
    publishedYear: integer("published_year"),
    language: text("language"),
    description: text("description"),
    coverUrl: text("cover_url"),
    coverPath: text("cover_path"),
    pageCount: integer("page_count"),
    series: text("series"),
    seriesIndex: real("series_index"),
    genres: text("genres").array().notNull().default([]),
    tags: text("tags").array().notNull().default([]),
    hardcoverBookId: integer("hardcover_book_id"),
    hardcoverEditionId: integer("hardcover_edition_id"),
    // NOT NULL: every book has an owner, which is what lets authorization drop
    // its "unowned book" branch. RESTRICT rather than CASCADE or SET NULL —
    // deleting a user must not delete or orphan their books.
    //
    // What satisfies it is `reassignBooksOnRemoveUser` (lib/user-deletion.ts):
    // it moves the target's books to the acting admin BEFORE Better Auth's
    // deletion runs, so this constraint has nothing left to reject. A path that
    // forgets fails loudly here — and loudly is not the same as safely: Better
    // Auth's deletion is three un-transacted statements, so the rejection lands
    // after the sessions and accounts rows are already gone.
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    possibleDuplicateOf: uuid("possible_duplicate_of"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    searchVector: tsvector("search_vector"),
  },
  (t) => [
    index("books_status_created_at_idx").on(t.status, t.createdAt),
    index("books_isbn13_idx").on(t.isbn13),
    index("books_search_vector_idx").using("gin", t.searchVector),
    index("books_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("books_author_trgm_idx").using("gin", t.author.op("gin_trgm_ops")),
    index("books_series_idx")
      .on(t.series)
      .where(sql`series IS NOT NULL`),
    index("books_possible_duplicate_of_idx")
      .on(t.possibleDuplicateOf)
      .where(sql`possible_duplicate_of IS NOT NULL`),
    foreignKey({
      columns: [t.possibleDuplicateOf],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    // No longer partial: created_by is NOT NULL, so the predicate excluded nothing.
    index("books_created_by_idx").on(t.createdBy),
    index("books_hardcover_book_id_idx")
      .on(t.hardcoverBookId)
      .where(sql`hardcover_book_id IS NOT NULL`),
    uniqueIndex("books_series_series_index_uniq")
      .on(t.series, t.seriesIndex)
      .where(sql`series IS NOT NULL AND series_index IS NOT NULL`),
  ],
);

/** All book columns except searchVector (internal FTS column, never sent to clients). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { searchVector: _sv, ...bookColumns } = getColumns(books);
export { bookColumns };

export const bookFiles = pgTable(
  "book_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    originalName: text("original_name").notNull(),
    storagePath: text("storage_path"),
    inboxPath: text("inbox_path"),
    fileSize: bigint("file_size", { mode: "number" })
      .notNull()
      .default(sql`0`),
    checksum: text("checksum"),
    contentHash: text("content_hash"),
    originalContentHash: text("original_content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("book_files_book_id_idx").on(t.bookId),
    index("book_files_checksum_idx").on(t.checksum),
    index("book_files_content_hash_idx").on(t.contentHash),
    index("book_files_original_content_hash_idx").on(t.originalContentHash),
  ],
);

export const bookMetadataCandidates = pgTable(
  "book_metadata_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    rawResponse: jsonb("raw_response"),
    normalized: jsonb("normalized").$type<NormalizedMetadata>().notNull().default({}),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull().default("0"),
    selectedFields: text("selected_fields").array().notNull().default([]),
  },
  (t) => [
    index("book_metadata_candidates_book_id_idx").on(t.bookId),
    unique("book_candidates_book_source_uniq").on(t.bookId, t.source),
  ],
);

export const readingProgress = pgTable(
  "reading_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: intentionally preserved when a book is deleted so reading
    // history is not lost. Set to NULL via onDelete cascade from books table.
    bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    document: text("document").notNull(),
    device: text("device").notNull(),
    deviceId: text("device_id"),
    progress: text("progress").notNull(),
    percentage: numeric("percentage", { precision: 5, scale: 4 }).notNull().default("0"),
    timestamp: bigint("timestamp", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    rawPayload: jsonb("raw_payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("reading_progress_user_document_device_uniq").on(t.userId, t.document, t.device),
    index("reading_progress_device_idx").on(t.device),
    index("reading_progress_book_id_idx").on(t.bookId),
    index("reading_progress_user_id_idx").on(t.userId),
  ],
);

export const readingProgressHistory = pgTable(
  "reading_progress_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: same intentional semantics as readingProgress.bookId — history
    // rows survive book deletion.
    bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    document: text("document").notNull(),
    device: text("device").notNull(),
    progress: text("progress").notNull(),
    percentage: numeric("percentage", { precision: 5, scale: 4 }).notNull().default("0"),
    timestamp: bigint("timestamp", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reading_progress_history_document_created_at_idx").on(t.document, t.createdAt),
    index("reading_progress_history_created_at_idx").on(t.createdAt),
    index("reading_progress_history_book_id_idx").on(t.bookId),
    index("reading_progress_history_user_id_idx").on(t.userId),
  ],
);

// Per-(user, book) reading lifecycle aggregate. startedAt is set the first
// time we see percentage > 0; finishedAt is set the first time we see
// percentage >= FINISHED_THRESHOLD. Neither is overwritten once set —
// rereading a finished book does not reset the original timestamps.
//
// manual_* fields are user-set overrides that win over computed values until
// cleared. KoSync continues to populate started_at / finished_at; manual_set_at
// flags whether the user has actively overridden the computed status.
//
// external_status is pulled from external services (Hardcover) and used as a
// fallback when Libris has no local reading data for a book. It never feeds
// the push side of any sync to avoid loops — only manual_status does.
export const readingAggregate = pgTable(
  "reading_aggregate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Nullable, mirroring readingProgress.bookId — aggregate survives book deletion.
    bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    manualStatus: readingStatusEnum("manual_status"),
    manualStartedAt: timestamp("manual_started_at", { withTimezone: true }),
    manualFinishedAt: timestamp("manual_finished_at", { withTimezone: true }),
    manualPausedAt: timestamp("manual_paused_at", { withTimezone: true }),
    manualSetAt: timestamp("manual_set_at", { withTimezone: true }),
    externalStatus: readingStatusEnum("external_status"),
    externalStatusSyncedAt: timestamp("external_status_synced_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("reading_aggregate_user_book_uniq").on(t.userId, t.bookId),
    index("reading_aggregate_book_id_idx").on(t.bookId),
    index("reading_aggregate_user_id_idx").on(t.userId),
  ],
);

/**
 * Per-user credential for an external service. Hardcover is the only remaining
 * occupant: OPDS credentials were removed with the service, and KoSync moved to
 * `kosync_credentials`.
 *
 * `username` is a LABEL, not an identity. Nothing authenticates against it --
 * the frontend sends the literal string "hardcover" for every user (see
 * SettingsHardcover.vue), and the token in `password_hash` is what actually
 * talks to the API. It is therefore deliberately NOT unique across users; the
 * global `(service, username)` unique index that used to be here let exactly
 * one person in the whole install connect Hardcover and 500'd the second.
 * `(service, user_id)` is the constraint that still matters.
 */
export const serviceCredentials = pgTable(
  "service_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service: text("service").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("service_credentials_service_user_uniq").on(t.service, t.userId),
    index("service_credentials_user_id_idx").on(t.userId),
  ],
);

/**
 * KoSync credentials, deliberately NOT Better Auth api keys.
 *
 * KOReader sends `x-auth-user` and `x-auth-key`, where x-auth-key is
 * md5(password) — the plaintext never travels, so the md5 digest IS the bearer
 * secret. Forcing this onto the apiKey plugin would mean storing
 * md5(appPassword) while showing appPassword to the user, and the plugin only
 * lets you influence the stored value through customKeyGenerator, which takes
 * no per-call context. That needs AsyncLocalStorage — action at a distance in
 * the credential-minting path, to satisfy one client's quirk. The weirdness
 * stays at the edge instead.
 *
 * secret_hash holds `v1$<salt-hex>$<hmac-hex>`: a per-row-salted HMAC-SHA256
 * of the exact value KOReader puts on the wire, keyed by a pepper derived from
 * API_SECRET_KEY. The version and salt live inside the column so the format can
 * move again without a migration, and pre-v1 rows -- a bare unsalted sha256 --
 * still verify and are rewritten on the owner's next successful sync.
 *
 * The wire value is md5 of a HUMAN-CHOSEN password, not a random token, so a
 * bare digest here was offline-crackable for every row at once.
 * A password hash is not the answer either: this is verified on an
 * unauthenticated endpoint that KOReader hits on every progress read and write,
 * where a work factor is a CPU-exhaustion lever. shared/kosync-auth.ts has the
 * full reasoning and states what the scheme does not protect against.
 */
export const kosyncCredentials = pgTable(
  "kosync_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Lookup is by username, which is what KOReader sends; unique because it is
    // the identity KOReader knows the account by.
    uniqueIndex("kosync_credentials_username_uniq").on(t.username),
    // One KoSync credential per person, matching the old (service, user) unique.
    uniqueIndex("kosync_credentials_user_id_uniq").on(t.userId),
  ],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Ephemeral registry linking an uploaded file's checksum to the user who
 * uploaded it.  Rows are consumed by the book-detected worker to assign book
 * ownership and deleted once consumed — one row at a time, matched against the
 * file actually being ingested.  Rows that are never picked up (e.g. worker
 * crash) are orphans and could benefit from periodic TTL-based cleanup.
 *
 * `filename` is the name the file was written under IN THE INBOX, which is not
 * necessarily the name the browser sent: `writeInboxFile` appends `-1`, `-2`, …
 * on collision.  The worker matches on it, so it has to describe the file on
 * disk.  (It is also what becomes `book_files.original_name`, so a collided
 * upload is displayed under its on-disk name — recording both would need a
 * second column and a migration.)
 */
export const uploadRegistry = pgTable(
  "upload_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checksum: text("checksum").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("upload_registry_checksum_user_uniq").on(t.checksum, t.userId)],
);

export const hardcoverSyncLog = pgTable(
  "hardcover_sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hardcoverUserBookId: integer("hardcover_user_book_id"),
    hardcoverReadId: integer("hardcover_read_id"),
    lastStatus: text("last_status"),
    lastProgress: numeric("last_progress", { precision: 5, scale: 4 }),
    lastRating: numeric("last_rating", { precision: 3, scale: 1 }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("hardcover_sync_log_user_book_uniq").on(t.userId, t.bookId),
    index("hardcover_sync_log_status_idx").on(t.lastStatus),
    index("hardcover_sync_log_last_synced_at_idx").on(t.lastSyncedAt),
    index("hardcover_sync_log_user_id_idx").on(t.userId),
  ],
);
