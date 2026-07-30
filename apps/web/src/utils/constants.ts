export const DEFAULT_PAGE_SIZE = 20;

/** Accepted book file extensions (comma-separated for input[accept]). */
export const ACCEPTED_BOOK_EXTENSIONS = ".epub";

/** Accepted extensions as a Set for fast membership checks. */
export const ACCEPTED_BOOK_EXTENSION_SET = new Set([".epub"]);

/** Maximum upload file size in bytes (100 MB). */
export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
