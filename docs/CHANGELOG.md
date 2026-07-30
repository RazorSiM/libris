# @libris/docs

## 1.1.2

### Patch Changes

- 11664da: Make the unit-test tasks cacheable again.

  Both `@libris/api-hono#test` and `@libris/web#test` were reported by Vite Task as
  `not cached because they modified their inputs` on every single run — locally and
  in CI. The cause: loading a TypeScript `vite.config.ts` makes Vite write a
  transient `.mjs` into `node_modules/.vite-temp/`, import it, then delete it.
  Because both tasks declare `input: [{ auto: true }]`, which tracks the whole
  package directory, that write lands inside the tracked input set and the task
  fingerprint changes mid-run.

  Excluding `node_modules/.vite-temp/**` from both tasks fixes it. A repeat
  `vp run -r test` with no changes now reports 3/3 cache hit and finishes in
  0.19s instead of re-running the full suite (~73s locally, ~5 minutes on a
  2-core CI runner, since the api-hono suite is 481 tests each bootstrapping a
  PGlite instance).

- 75bb9af: Port CI/CD from Forgejo Actions to GitHub Actions, and publish images to GHCR.

  `.github/workflows/ci.yml` replaces `.forgejo/workflows/ci.yml`: jobs move to
  `ubuntu-latest`, `setup-vp` loses its Forgejo-only full-URL form, and the
  artifact actions go to v4 (v3 was shut down on github.com in January 2025). The
  separate `e2e-pr` and `e2e-main` jobs are merged into one `e2e` job that selects
  the `@smoke` subset on pull requests and the full suite on pushes, so the
  service, container, and env setup can no longer drift between them. Shards go
  from 2 to 3, and a `concurrency` group cancels superseded runs. The bespoke
  PR-comment step that called the Forgejo issues API is dropped — GitHub's native
  checks UI already reports per-shard status.

  `.github/workflows/release.yml` replaces `publish-images.yml` and switches the
  release strategy to `changesets/action@v1`. Releases are now PR-gated: merging
  to main opens a "chore: version packages" PR, and merging that is what triggers
  the release. The action runs without a `publish` input, since no workspace goes
  to npm.

  The old two-job split existed only because the Forgejo runners were split — one
  had Node without a Docker daemon, the other a daemon without Node. A GitHub
  runner has both, so the `ci/release-<run_id>` staging branch, the re-clone, and
  the rebase-onto-main are all gone. Publishing is idempotent via the existing
  composite-tag registry check, so no commit-message sniffing is needed to detect
  the version merge. Registry auth uses the built-in `GITHUB_TOKEN`, retiring the
  `REGISTRY_TOKEN` secret, and the build gains buildx with a GitHub Actions layer
  cache.

  Docs and agent instructions follow: `docs/ci-cd.md` is rewritten for the new
  workflows and documents the release flow, `docs/deployment.md` points at
  `ghcr.io/razorsim/libris`, and `fj` is replaced by `gh` throughout AGENTS.md,
  CLAUDE.md, README.md, and `docs/contributing.md`.

- 75bb9af: Upgrade Vite+ from 0.1.24 to 0.2.6 and move the Node toolchain to 26.5.0.

  Vite+ 0.2.0 dropped `@voidzero-dev/vite-plus-test` (its rebundled Vitest copy) and
  now runs upstream Vitest, pulled in transitively by `vite-plus`. The workspace
  catalog no longer aliases `vitest` to the removed wrapper, and the `vitest`
  override / peer-dependency rules that existed only to serve that alias are gone.
  `import ... from "vite-plus/test"` is unaffected.

  Toolchain moves with it: Vite 8.0.16 -> 8.1.5, Rolldown 1.0.3 -> 1.2.0,
  Vitest 4.1.8 -> 4.1.10 (includes the GHSA-p63j-vcc4-9vmv fix), oxfmt 0.52 -> 0.60,
  oxlint 1.67 -> 1.75, oxlint-tsgolint 0.23 -> 7.0.2001 (stable tsgolint 7),
  tsdown 0.22.1 -> 0.22.13.

  Node 26 pins brought in step with the runtime:

  - `.node-version` pinned to `26.5.0` (was the floating major `26`)
  - Docker images pinned to `node:26.5.0-slim`, with `pnpm@11.5.0` matching
    `packageManager` and `vite-plus@0.2.6` pinned in the builder stage
  - `@types/node` catalog bumped `^25` -> `^26` to match the runtime major
  - api-hono's tsdown `target` corrected `node24` -> `node26`, so the bundle is no
    longer down-levelled below the runtime it actually ships on

  Also fixes the local `test:e2e:docker` path, which could not boot:

  - the Playwright image ships Node 24, below the `engines.node` floor, so the
    compose entrypoint now provisions the pinned Node via `n` into a cached volume
    and installs pnpm explicitly (Node 25+ no longer bundles corepack)
  - `playwright.config.ts` invoked `pnpm --filter @libris/web run dev`, a script the
    Vite+ task migration had removed; it now goes through `vp run -F @libris/web dev`

- 75bb9af: Convert the user-guide screenshots from PNG to WebP.

  All 29 images in `docs/guide/images/` are now WebP at quality 90 (`webp:method=6`),
  and every reference in `README.md` and `docs/guide/*.md` was rewritten to match.

  This was the dominant cost in the repo: the PNGs were 7.9MB of a 12MB tracked
  tree, all of them unoptimized retina-scale captures at 1376x1403. WebP brings
  that to 1.8MB, a 77% reduction, taking the whole tracked tree from 12MB to 5.4MB
  — a cost every clone was paying.

  Quality 90 was chosen after measuring: PSNR 41.6dB, and a 1:1 crop of a
  text-dense region is visually indistinguishable from the original, which matters
  because these are UI screenshots where readers need to make out interface text.

  Application images are deliberately untouched — `apps/web/public/` favicons and
  PWA icons must stay PNG/ICO for manifest and `apple-touch-icon` compatibility,
  and the logos are already SVG.

- Updated dependencies [11664da]
- Updated dependencies [75bb9af]
- Updated dependencies [75bb9af]
- Updated dependencies [75bb9af]
  - @libris/api-hono@1.1.2

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
