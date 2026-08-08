---
"@libris/api-hono": patch
---

Make `/api/reading-status/*` work on both database drivers, and give the three
call sites that needed it one shared row normaliser.

Drizzle's `db.execute()` resolves to an array-like `RowList` under postgres-js
and to a `{ rows }` object under PGlite. `getReadingStatusCounts` and
`getBooksByReadingStatus` read their rows out of the result directly, so both
endpoints answered only on postgres-js and threw `result is not iterable` on
PGlite. Production was unaffected — but the ordinary test harness runs PGlite,
which is why `/api/reading-status/counts` had no integration coverage at all
and its per-user scoping went unverified through the multi-user cutover.

`rowsOf()` and `rowCount()` now live in `src/db/rows.ts` and are used by
`lib/reading-status.ts`, `routes/api/stats.ts` and `lib/progress-linking.ts`,
each of which previously carried (or lacked) its own copy. Both reading-status
endpoints are now driven over HTTP on the standard harness.
