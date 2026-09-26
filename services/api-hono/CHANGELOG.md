# @libris/api-hono

## 2.0.1

### Patch Changes

- 762d6cf: Stop a book's `possibleDuplicate` link from leaking another user's private upload. The metadata worker writes the duplicate id with no owner predicate, and the inbox detail route resolved and returned it for any caller, exposing the target's title, author and status (and its existence). The lookup now follows the same visibility rule as the rest of the inbox — own books plus the shared organized library, everything for admins — and the raw `possibleDuplicateOf` FK is no longer part of any API response; only the resolved, visibility-checked object is.
- 762d6cf: Take EPUB metadata rewriting off the API event loop. The OPF scans in `embed-metadata` now use the same single-pass XML scanner as the metadata extractor instead of regexes that backtracked quadratically (measured 7.3 s for a 160 KiB crafted OPF), OPF documents over `LIBRIS_MAX_EMBED_OPF_BYTES` (default 1 MiB) are refused before rewriting, and the whole rewrite — including the synchronous DEFLATE recompression — runs in a `node:worker_threads` worker with a hard `LIBRIS_EMBED_TIMEOUT_MS` (default 30 s) timeout. A worker crash or timeout leaves that book un-embedded and the organize job continues instead of stalling every HTTP request.
- 762d6cf: Drain delayed jobs from a queue. `POST /api/jobs/queues/{name}/drain` documented removing waiting and delayed jobs, but called BullMQ's `drain()` without `true`, leaving scheduled jobs behind.
- 762d6cf: Make job browser pagination honest and bounded. `GET /api/jobs` derived `total` and `totalPages` from the first 200 jobs per queue, so a queue with more jobs reported a truncated total and deep pages came back empty with no explanation. `total` now comes from BullMQ's counters (exact); each selected queue/status board is read in its native order up to its share of a 10,000-job window, jobs are attributed to the board they came from (no per-job `getState()` round trip), and the merged window is ordered by creation time with a deterministic queue/id tie-break. Pages past the window are answered from the counters without touching Redis, and the response carries a `truncated` flag — surfaced in the settings browser — when any board holds more matching jobs than the window reaches.
- 762d6cf: Close two KoSync brute-force gaps. `POST /kosync/users/auth` is now bucketed by the username in the JSON body — the value the handler verifies — instead of `x-auth-user`, so a header that disagrees with the body can no longer buy a fresh budget per guess. The progress routes (`GET`/`PUT /kosync/syncs/progress`) now share the per-user credential budget, with only failed checks counted: a locked-out identity is refused with 429 before verification, a device that keeps syncing never spends the budget, and a verified check clears recorded failures.
- 762d6cf: Stop logging raw Better Auth keys when Redis degrades. A key embeds live material — a session token, a single-use verification token, or `<ip>|<path>` for a rate-limit counter — and a log line is a copy kept longer and read more widely than Redis. Failure warnings now carry a category (`credential`, `rate-limit`, `active-sessions`) and a truncated SHA-256 so lines still correlate without exposing the secret.
- 762d6cf: Bound the endpoints that enqueue metadata and Hardcover work. `POST /api/library/{id}/refetch` and `PATCH /api/inbox/{id}/rescan` now share a deterministic job id (repeat clicks collapse into the in-flight job) and a per-user cap of 10 in-flight metadata jobs, returning 429 beyond it; `POST /api/hardcover/sync` dedups on a per-user job id and answers "Sync already queued" instead of adding another job, and it now uses the registered scheduler queue rather than opening and closing a Redis connection per request (503 if that queue is not running). `GET /api/hardcover/status` caches the live token verification per user for 30 seconds, and connecting or disconnecting a Hardcover credential clears that cache.
- 762d6cf: Fix Redis URL credential parsing: an ACL username in `REDIS_URL` (from `REDIS_USER`) is now passed to ioredis, and percent-encoded usernames and passwords are decoded, so credentials containing reserved characters authenticate.
- 762d6cf: Prevent data loss in the book-organize and cleanup workers, and fix inbox navigation after client-side route changes.

  - Organize now gives each book its own id-suffixed library directory and moves files with a no-clobber operation, so two books with the same author/title/filename can no longer overwrite each other; a retry after an interrupted move adopts a destination only when its bytes match a recorded hash — the upload checksum or the embedded content hash — so a re-organize interrupted after metadata embedding also recovers.
  - Forced cover re-download no longer deletes the existing cover before the replacement has been fetched.
  - A failed EPUB metadata rewrite removes its `.tmp` leftover, and a re-organize removes the old directory's cover once no other book references it.
  - Cleanup only deletes a `book_files` row on a confirmed `ENOENT`/`ENOTDIR` and keeps (and reports) records it cannot read.
  - The inbox detail page derives its book id reactively, resets per-book state on navigation, and filters server events by the book currently on screen, so rescan/approve/delete reach the right book.

- 762d6cf: Treat admin as a membership test rather than an exact role match. Better Auth stores multiple roles as a comma-joined string, so a user with `admin,user` is now counted as an active admin by the last-admin guard (SQL and session checks), granted admin routes, and shown as an admin in the settings user list. Previously the two-step demotion `admin` → `admin,user` → `user` could lock the sole admin out of the install.
- 762d6cf: Keep reading-statistics baselines when the sample's book was deleted, and stop a zero-delta day from seeding an empty velocity chart. Deleting a book sets its progress-history `book_id` to NULL; an inner join dropped that row, so the first in-period sample was counted from zero a second time (a book at 50% on Dec 31 and 51% on Jan 1 reported 51 pages instead of 1). The baseline queries now left-join the book, and the moving-average bounds only consider days with a positive delta. Adds an index on `(user_id, document, device, created_at DESC)` for the per-stream baseline lookup, which otherwise sorted the user's whole history on every cache miss.
- 762d6cf: Average reading velocity over calendar days. The 7-day moving average slid over days that had syncs, so a week with reads on only two days divided by two instead of seven and idle days were missing from the series entirely; the window is now filled from a `generate_series` calendar, starting six days before the first day with a read. An install with no reads still reports an empty series rather than 90 zeroes.
- 762d6cf: Rank `GET /api/stats`'s genre distribution by numeric book count. The query ordered by the serialized text alias, so with ten or more genres a count of 9 outranked 10 and the top-ten cutoff could drop a more popular genre; ties now break deterministically by name.
- 762d6cf: Fix stats period boundaries double-counting progress. Page deltas for the heatmap and reading velocity were computed after filtering history to the display period, so the first sync of a period had no previous sample and its whole percentage counted as pages read (a 100-page book at 50% on Dec 31 and 51% on Jan 1 reported 51 pages instead of 1). Each `(document, device)` stream now carries its last pre-period sample as the LAG baseline, with only in-period rows aggregated.
- 762d6cf: Compare the full canonical origin (scheme, host, and port) for cookie-authenticated mutations and WebSocket upgrades. A same-host origin on a different port — which `SameSite` cookies cannot separate, since they are site-scoped rather than port-scoped — is now rejected with 403, and valid IPv6 origins such as `http://[::1]:3000` are accepted instead of rejected. The scheme comes from `x-forwarded-proto` only when `TRUST_PROXY_HEADERS=1`; reverse proxies should forward it (see _Reverse Proxy_ in the deployment docs).
- 762d6cf: Make search tolerant of punctuation. All four search endpoints (/api/search, /api/library, /api/inbox, /opds/search) shared a sanitizer that stripped most tsquery operators but not the apostrophe, so a query such as `foo&'` built a tsquery Postgres rejects and answered 500. They now share `buildPrefixTsquery`, which drops apostrophes so `children's` still reaches the English stemmer as one word and replaces every other syntax character (including `-`, which silently meant "phrase") with a separator, returning null — and therefore an unfiltered or empty result — when nothing searchable remains.
- 762d6cf: Bind the OpenAPI-only tooling server to loopback. `openapi-server.ts` serves a router with no auth middleware (started by `bruno-import.sh`), and `serve()` without a hostname listened on every interface; it now binds `127.0.0.1` so the tooling port is not reachable from the network.
- 762d6cf: Bound inbox uploads before multipart parsing. `POST /api/inbox/upload` now enforces an aggregate byte cap as the body streams — so a chunked request cannot buffer past it — and a file-count cap; both are configurable through `LIBRIS_MAX_UPLOAD_BYTES` (default 1 GiB) and `LIBRIS_MAX_UPLOAD_FILES` (default 20). Previously only `Content-Length`-declared, per-file sizes were checked after the whole request had already been buffered in memory. Also upgrades Hono to 4.13.8, resolving three moderate advisories (including unbounded dot-notation nesting in `parseBody`).
- 762d6cf: Cap inbound WebSocket frames at 64 KiB. The event socket only acts on the literal `"ping"` text, but `ws` defaults to a 100 MiB frame limit, so an authenticated client could make the process buffer hundreds of MiB across its allowed sockets and have every byte discarded. Oversized frames now close the connection with code 1009.

## 2.0.0

### Major Changes

- 1b6c424: Multi-user authentication, and a security pass over everything it touched.

  Libris now has real user accounts. Authentication moves from a single shared API
  key to Better Auth: people sign in with an email and password, admins manage
  other accounts, and e-readers and scripts authenticate with per-user **app
  passwords** instead of one install-wide key. Books, reading progress, inbox
  uploads and third-party credentials all belong to a person now, so an install
  can be shared without everyone seeing everyone else's things.

  ## Breaking

  Read the **"Upgrading to the Better Auth Release"** runbook in
  `docs/deployment.md` before deploying. In short:

  - **`BETTER_AUTH_SECRET` is required.** Generate it with `openssl rand -base64
32`. Published placeholders and low-diversity values are rejected at startup,
    so a copied `.env.example` will not boot.
  - **`BETTER_AUTH_URL` is required when `NODE_ENV=production`**, and must be the
    public origin the browser actually reaches — scheme and host only, no path.
    Better Auth does not infer an HTTPS origin behind a TLS-terminating proxy; it
    reads the container's plain-HTTP socket, so leaving this unset makes every
    browser sign-in fail with `403 INVALID_ORIGIN`.
  - **`COOKIE_DOMAIN` is gone.** The session cookie is host-only, so Libris must be
    served from a single origin. The variable is now ignored rather than rejected,
    so a compose file that still sets it gets no error — delete it.
  - **Everyone is signed out** by the upgrade, and **API keys stop working**.
    Re-pair e-readers with app passwords minted under Settings → Connections.
  - **KoSync and OPDS credentials must be regenerated.** OPDS now authenticates
    with an account email plus an app password.
  - **Rotating `API_SECRET_KEY` now invalidates every KoSync credential**, because
    stored secrets are peppered with a key derived from it. Every paired reader has
    to be paired again after a rotation.
  - **Unbanning does not restore app passwords.** Banning disables the user's app
    passwords; lifting the ban leaves them disabled and the user must mint new ones.
  - **Upload API:** a file already in the library is reported in a new `skipped[]`
    array rather than `errors[]`, and a batch in which every file was already
    present now answers `200` instead of `400`.
  - **OpenAPI:** the `BookApprovedResponse` component is replaced by `BookUpdated`
    (a superset of its fields — no client loses anything).

  Upgrading an install that predates this release does **not** need SQL: the
  first-run form adopts the existing account, so an operator signs in through it
  and sets a password.

  ## Added

  - Sign-in, first-run admin setup, and an Account tab for changing your own name
    and password, listing the devices you are signed in on, and revoking them.
  - A Users tab for admins, with the last admin protected from demotion, ban and
    deletion through every path that could otherwise strip them.
  - Per-user Hardcover accounts. Previously only one user per install could connect
    one, and a scheduled sync spent whichever token sorted first; the install-wide
    phase now uses an admin's token and skips, loudly, if no admin has connected.
  - `GET /api/health/live`, an I/O-free liveness probe for container health checks.
    `GET /api/health` keeps its existing readiness semantics and its response shape.
  - The realtime event socket now follows the session: it closes when the session
    behind it is revoked, and re-dials to be re-scoped when your role changes
    rather than signing you out.

  ## Fixed and hardened

  Ownership is now enforced on every read surface — inbox, dashboard counts, search
  suggestions, uploader attribution and library facets no longer leak other users'
  pre-approval uploads or raw user ids. Rate limiting buckets IPv4 clients
  individually, applies a per-credential budget to KoSync and sign-in, and bounds
  the request body before it is parsed. EPUB parsing runs in linear time and
  refuses archives crafted to exhaust memory. Redis is treated as a cache rather
  than the authority on who is signed in, so an outage degrades instead of signing
  everyone out. Remote cover fetching, ingestion paths, WebSocket upgrades and
  proxy-derived client addresses are all validated at their boundaries.

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
