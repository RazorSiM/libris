/**
 * Helpers for detecting and handling PostgreSQL error codes in route handlers.
 */

/** PostgreSQL unique_violation error code. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Walk an error's `cause` chain, outermost first.
 *
 * Drizzle 1.0 no longer lets driver errors through untouched: every failed
 * query is rethrown as a `DrizzleQueryError` carrying `{ query, params, cause }`,
 * with the postgres.js / PGlite error underneath. Reading `err.code` off the
 * top-level object therefore always yields undefined, which is why the checks
 * below unwrap before looking. The chain is bounded so a self-referential
 * `cause` cannot spin.
 */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  let current = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return;
    const record = current as Record<string, unknown>;
    yield record;
    current = record.cause;
  }
}

/**
 * Returns true when the given error is a PostgreSQL unique-constraint violation.
 * Works with node-postgres (DatabaseError), postgres.js and PGlite error shapes,
 * wrapped or not.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (const link of errorChain(err)) {
    if (link.code === PG_UNIQUE_VIOLATION) return true;
  }
  return false;
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
  for (const link of errorChain(err)) {
    // node-postgres and postgres.js spell it `constraint`; PGlite uses
    // `constraint_name`. Both appear in practice — PGlite backs the tests.
    const constraint = link.constraint ?? link.constraint_name;
    if (typeof constraint === "string" && CONSTRAINT_MESSAGES[constraint]) {
      return CONSTRAINT_MESSAGES[constraint];
    }
  }
  return "A record with the same unique values already exists";
}
