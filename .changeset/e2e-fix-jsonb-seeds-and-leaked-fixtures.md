---
"@libris/api-hono": patch
---

Fix three E2E regressions from the second remediation wave, and add the coverage
that would have caught them.

- **The metadata picker rendered no sources at all** (`errors.spec.ts` 409
  conflict, `inbox.spec.ts` "11 fields with radio buttons per source"). The seed
  helpers wrote `book_metadata_candidates.normalized` as
  `${JSON.stringify(obj)}::jsonb`. postgres-js serialises a jsonb parameter with
  `JSON.stringify`, so an already-encoded string is encoded twice and the column
  holds a jsonb _string_, not an object — `jsonb_typeof` = `'string'`. That was
  always true; drizzle-orm 1.0.0-beta's `PgJsonb.mapFromDriverValue` JSON.parse'd
  any string it was handed and repaired the row on read. The upgrade to
  1.0.0-rc.4 (59m.37) moved jsonb onto the codec system with no read-side
  normalisation, so the string reached the client, `MetadataFieldPicker` found no
  field on it, and every seeded review page showed "No metadata found — enter
  manually" with `Approve (0)` while still reporting "2 metadata sources found".
  Seeding now goes through one helper that uses `sql.json()` and asserts
  `jsonb_typeof = 'object'` at insert time. No production write path was
  affected: Drizzle's postgres-js driver marks the jsonb serialiser transparent
  on both versions.

- **The last-admin lock test found two admins** (`auth.spec.ts` "the last admin
  cannot be demoted out of existence"). `createDisposableAccount` never deleted
  anything, and two wave-2 specs create `admin` accounts with it, so the second
  admin outlived the file and left the demote button legitimately enabled.
  Accounts are now tracked and removed by `disposeAccounts()` in the teardown of
  the specs that create them.

- **A duplicate-detection job leaked into the next spec file**
  (`inbox.spec.ts` "empty inbox shows placeholder message"). chokidar only
  reports a dropped file after `awaitWriteFinish.stabilityThreshold`, so
  `waitForJob("book-detected")` returned on a queue that was idle because the
  watcher had not fired yet: the test asserted deduplication before it had been
  attempted, and the job then ran during the _next_ file, after its
  `deleteAllBooks()` had removed the book whose checksum it would have matched —
  ingesting the "duplicate" as a new book. The test now waits past the stability
  window, and the teardown clears the inbox directory (hand-dropped files have no
  `upload_registry` row, so the worker never removes them itself).

New: `tests/jsonb-metadata.postgres.test.ts` pins, against real PostgreSQL, that
a jsonb candidate round-trips to the client as an object and that a jsonb string
is _not_ silently rehydrated into one. PGlite cannot cover this — jsonb decoding
is the driver's job, and it is a different driver.
