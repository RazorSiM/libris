/**
 * One normaliser for the two shapes `db.execute()` resolves to.
 *
 * Drizzle does not flatten this for us: the postgres-js driver resolves a raw
 * `db.execute()` to an array-like `RowList` (iterable, `.map`, `[i]`), while
 * the PGlite driver resolves it to a `Results` object whose rows live under
 * `.rows`. Code that touches either shape directly therefore works on exactly
 * one driver — and since production runs postgres-js and the test harness runs
 * PGlite, "works in production, 500s in tests" is the shape of the bug. That is
 * not a flake to route around: an endpoint that cannot run on the harness gets
 * no integration coverage at all, which is how `/api/reading-status/counts`
 * stayed untested through a multi-user cutover (libris-6lt).
 *
 * Three call sites had grown their own private copy of this before it was
 * extracted here (`routes/api/stats.ts`, `lib/progress-linking.ts`, and the
 * missing one in `lib/reading-status.ts`). Prefer these helpers over reaching
 * into a result object; `db.select()` and friends already return plain arrays
 * and need nothing.
 */

/** The rows of a Drizzle `db.execute()` result, whatever driver produced it. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") {
    const { rows } = result as { rows?: unknown };
    if (Array.isArray(rows)) return rows as T[];
    if (typeof (result as Iterable<T>)[Symbol.iterator] === "function") {
      return Array.from(result as Iterable<T>);
    }
  }
  return [];
}

/** How many rows a Drizzle `db.execute()` returned, whatever driver produced it. */
export function rowCount(result: unknown): number {
  return rowsOf(result).length;
}
