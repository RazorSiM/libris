export const QUEUE_BOOK_DETECTED = "book-detected";
export const QUEUE_BOOK_PARSE_FILE = "book-parse-file";
export const QUEUE_BOOK_FETCH_METADATA = "book-fetch-metadata";
export const QUEUE_BOOK_ORGANIZE = "book-organize";
export const QUEUE_PROGRESS_HISTORY_CLEANUP = "progress-history-cleanup";
export const QUEUE_HARDCOVER_SYNC = "hardcover-sync";
export const QUEUE_DB_MAINTENANCE = "db-maintenance";

export const QUEUE_NAMES = [
  QUEUE_BOOK_DETECTED,
  QUEUE_BOOK_PARSE_FILE,
  QUEUE_BOOK_FETCH_METADATA,
  QUEUE_BOOK_ORGANIZE,
  QUEUE_PROGRESS_HISTORY_CLEANUP,
  QUEUE_HARDCOVER_SYNC,
  QUEUE_DB_MAINTENANCE,
] as const;
