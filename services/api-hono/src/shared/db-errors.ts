/**
 * Helpers for detecting and handling PostgreSQL error codes in route handlers.
 */

/** PostgreSQL unique_violation error code. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Returns true when the given error is a PostgreSQL unique-constraint violation.
 * Works with both node-postgres (DatabaseError) and postgres.js error shapes.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<string, unknown>).code === PG_UNIQUE_VIOLATION;
}

/**
 * Maps known constraint names to user-friendly messages.
 * Add new entries here when new unique constraints are introduced.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  books_series_series_index_uniq:
    "Another book already exists with the same series and series index",
};

/**
 * Returns a human-readable message for a unique-violation error, falling back
 * to a generic message when the constraint name is not recognized.
 */
export function uniqueViolationMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const constraint = (err as Record<string, unknown>).constraint;
    if (typeof constraint === "string" && CONSTRAINT_MESSAGES[constraint]) {
      return CONSTRAINT_MESSAGES[constraint];
    }
  }
  return "A record with the same unique values already exists";
}
