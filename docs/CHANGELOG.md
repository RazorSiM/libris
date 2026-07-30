# @libris/docs

## 1.1.1

### Patch Changes

- cdb041f: Full documentation sweep: split the user guide into per-topic pages (Getting Started, Settings, Adding Books, Library & Series, Book Details, Reading & Stats, OPDS, Dashboard & Shortcuts) and regenerated all screenshots from the live app, adding new ones for the Hardcover search panel, edit-reading-status modal, library filters, series list/detail, and keyboard shortcuts.

  Corrected drift across the reference docs against the actual code: the toolchain is Vite+ (not Turborepo), the frontend is a Vue 3 + Vite+ SPA (not Nuxt), the organized library/OPDS catalog is shared across users (only progress, status overrides, credentials, uploads, and stats are per-user), Finished is >= 95% (not 100%), the book detail menu has five actions including Edit reading status, the Stats page has a yearly heatmap plus six charts, Series is a first-class feature, and OPDS has no top-level by-author feed. Also fixed Node 26 / pnpm 11 prerequisites, the CI caching/publish-images description, the testing counts and second auth setup project, and the environment/deployment variable tables.

  Fixed the database-doc generator (`docs/scripts/generate-docs.ts`): correct the migration note, mark primary keys NOT NULL, and emit foreign-key on-delete behaviour, per-table indexes, full table descriptions, and a schema-notes section.

  - @libris/api-hono@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [4b86d47]
  - @libris/api-hono@1.1.0

## 1.0.1

### Patch Changes

- Updated dependencies [1442ee7]
  - @libris/api-hono@1.0.1

## 1.0.0

Initial public release.
