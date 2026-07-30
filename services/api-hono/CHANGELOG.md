# @libris/api-hono

## 1.1.1

## 1.1.0

### Minor Changes

- 4b86d47: Make book language a canonical ISO 639-1 code everywhere so language filtering is reliable.

  - Add a shared, dependency-free `normalizeLanguage`/`languageLabel`/`LANGUAGES` module (`@libris/api-hono/languages`) used by both the API and the web app.
  - Predict language at ingestion: normalize the embedded EPUB `<dc:language>` tag (`en-GB`/`English`/`eng` → `en`, `it-IT`/`Italian` → `it`). When the tag is missing or unrecognized, detect the language (`tinyld`) from a sample of the book's body prose (spine-ordered, skipping short front matter), falling back to the title + description. The approve, PATCH, and apply-metadata routes re-normalize on write as a safety net.
  - Replace the free-text language inputs with a searchable language **select** in the edit modal and the inbox review picker; the library filter, chips, table, and badges now display full language names while filtering by code.
  - Add a `db:normalize-languages` backfill script (dry-run by default, `--apply` to write) to clean up existing inconsistent values.
  - Add a "Browse by Language" OPDS catalog: a navigation feed listing only the languages present in the library (as full names) plus per-language acquisition feeds (`/opds/languages` and `/opds/languages/{code}`).

## 1.0.1

### Patch Changes

- 1442ee7: Fix books getting stranded in "inbox" and unapprovable when their EPUB has embedded metadata but the automatic Hardcover lookup returns no results. The metadata-fetch worker now promotes such books to "review" (they already hold a file-derived metadata candidate and are review-ready) instead of leaving them in "inbox", where the Approve action is permanently disabled even after a successful manual Hardcover search.

  Also fix the library `PATCH /api/library/:id` endpoint only re-organizing (and thus re-embedding the EPUB) when the cover changed. Editing an embedded field such as title, author, publisher, or description now re-runs organize so the on-disk EPUB and its file location stay in sync with the database instead of silently drifting.

## 1.0.0

Initial public release.
