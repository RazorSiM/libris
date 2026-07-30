# @libris/web

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
