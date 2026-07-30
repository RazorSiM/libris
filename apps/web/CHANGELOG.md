# @libris/web

## 1.1.1

### Patch Changes

- @libris/api-hono@1.1.1

## 1.1.0

### Minor Changes

- 4b86d47: Make book language a canonical ISO 639-1 code everywhere so language filtering is reliable.

  - Add a shared, dependency-free `normalizeLanguage`/`languageLabel`/`LANGUAGES` module (`@libris/api-hono/languages`) used by both the API and the web app.
  - Predict language at ingestion: normalize the embedded EPUB `<dc:language>` tag (`en-GB`/`English`/`eng` → `en`, `it-IT`/`Italian` → `it`). When the tag is missing or unrecognized, detect the language (`tinyld`) from a sample of the book's body prose (spine-ordered, skipping short front matter), falling back to the title + description. The approve, PATCH, and apply-metadata routes re-normalize on write as a safety net.
  - Replace the free-text language inputs with a searchable language **select** in the edit modal and the inbox review picker; the library filter, chips, table, and badges now display full language names while filtering by code.
  - Add a `db:normalize-languages` backfill script (dry-run by default, `--apply` to write) to clean up existing inconsistent values.
  - Add a "Browse by Language" OPDS catalog: a navigation feed listing only the languages present in the library (as full names) plus per-language acquisition feeds (`/opds/languages` and `/opds/languages/{code}`).

### Patch Changes

- Updated dependencies [4b86d47]
  - @libris/api-hono@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [1442ee7]
  - @libris/api-hono@1.0.1

## 1.0.0

Initial public release.
