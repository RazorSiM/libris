# Testing

## E2E Tests (Playwright)

173 spec test bodies across 18 spec files in `tests/e2e/`, running sequentially (1 worker, shared database). The setup projects add 3 executions, and `prod-config.spec.ts` (4 tests) runs only in its own CI job, so a complete ordinary run is 172 tests. Regenerate the exact counts with `vp exec playwright test --list` (run from `tests/e2e/`) rather than hand-counting.

### Test Files

| File                       | Tests | Tags            | Coverage                                                                                                                                    |
| -------------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.spec.ts`          | 17    | @smoke (4)      | Profile, password changes, session and device management, account access                                                                    |
| `auth.spec.ts`             | 47    | mostly @smoke   | Sign-in, sessions, authorization, app passwords, OPDS authentication, user management                                                       |
| `book-progress.spec.ts`    | 3     | @smoke          | Multi-device progress, empty state, finished badge                                                                                          |
| `command-palette.spec.ts`  | 3     | —               | Global search modal, navigation, book results                                                                                               |
| `errors.spec.ts`           | 5     | @smoke / @slow  | Error toasts, conflict handling, network failures, and duplicate file detection                                                             |
| `first-run-setup.spec.ts`  | 2     | — (see below)   | Empty-install setup and first-admin creation. Cannot be tagged — its project depends on `chromium`, and dependency projects ignore `--grep` |
| `hardcover.spec.ts`        | 10    | @smoke          | Token CRUD, status, sync button/log, feature toggles, persistence                                                                           |
| `home.spec.ts`             | 6     | @smoke          | Dashboard stats, currently reading, recently added, wide-screen card constraints                                                            |
| `inbox.spec.ts`            | 16    | @smoke          | List, search, pagination, empty state, metadata picker, approve, delete                                                                     |
| `ingestion.spec.ts`        | 1     | @slow @external | Full EPUB pipeline: detect → parse → review → approve → library                                                                             |
| `library.spec.ts`          | 18    | @smoke          | Grid/list view, filters, search, pagination, detail page, covers, downloads                                                                 |
| `isolation.spec.ts`        | 10    | @smoke (6)      | Ownership controls, per-user progress and stats, credential persistence, cache and upload isolation                                         |
| `prod-config.spec.ts`      | 4     | prod-config     | Production-config install: first-run setup, sign-in, sign-out, session revocation. Only runs in the `e2e-prod-config` CI job                |
| `opds.spec.ts`             | 2     | @smoke          | Real-filesystem cover and ebook streaming through the live server                                                                           |
| `reading-status.spec.ts`   | 8     | @smoke          | Sidebar links, status tabs, empty state, wide-screen cards, plus a parametrized loop covering the reading/finished/unread/paused tabs       |
| `settings.spec.ts`         | 8     | @smoke (4)      | Health & diagnostics (@smoke); jobs browser and queue management untagged                                                                   |
| `stats.spec.ts`            | 7     | @smoke          | Books finished, streaks, daily activity, genre distribution                                                                                 |
| `websocket-events.spec.ts` | 6     | @smoke (1)      | Realtime event bus over WebSocket — job status, pipeline events, Hardcover sync updates                                                     |

> **Note:** Feed structure, search, language filtering, authentication, and content-type
> contracts live in `services/api-hono/src/routes/opds.test.ts`. `opds.spec.ts` retains only
> the two cases that require the configured library directory and a running server: cover and
> ebook streaming.

### Tags

| Tag         | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `@smoke`    | Critical paths — runs on PRs via `--grep @smoke`                                |
| `@slow`     | File processing or queue waits                                                  |
| `@external` | Exercises a boundary normally backed by an external service or filesystem event |
| _untagged_  | Runs in the complete suite but not the PR smoke selection                       |

Untagged specs (command palette, jobs browser, most WebSocket cases) validate behavior that doesn't need to block every PR but must pass on main.

**`@smoke` is the PR gate's entire definition of "covered".** The `e2e` job runs
`--grep @smoke` on pull requests and the full suite only on pushes to main, so an
untagged spec first executes _after_ the merge that broke it. That is not a
theoretical cost: the auth work on this branch initially left `account.spec.ts`,
`isolation.spec.ts`, `websocket-events.spec.ts` and every `auth.spec.ts` block
except `sign-in` untagged, which meant app passwords, app-password scoping, OPDS
Basic auth, the admin user-management walk and the last-admin 409 were not
gating anything.

The rule now: **anything that pins an authentication, authorization, ownership or
session invariant carries `@smoke`.** Concretely that is the sign-in,
post-sign-in redirect, session, authorization, app-password, app-password-scope,
OPDS and user-management blocks of `auth.spec.ts`; the ownership, per-user
stats, sign-out cache and upload-collision blocks of `isolation.spec.ts`; the
WebSocket per-user event scoping case; and the password-change,
session-token-leak, device-revocation and non-admin-access cases in
`account.spec.ts`. Presentation and convenience coverage stays untagged so the
gate stays a gate. That takes the PR selection from 89 tests to 136.

::: warning `first-run-setup.spec.ts` cannot be tagged
Its `first-run` project declares `dependencies: ["chromium"]` so it sorts last —
it wipes every account, so nothing may follow it. Playwright does **not** apply
`--grep` to a dependency project: it runs the whole thing. Tagging anything in
that file therefore drags the entire `chromium` project into the PR run (136
tests becomes all 175) and the gate silently stops being a gate.

First-run setup runs on main only. If you want it on PRs, the honest change is
to run the full suite on PRs, not to tag the file.
:::

### What CI actually exercises

Green does not mean "every configuration works" — it means the configurations
below were tried.

| Config branch                                     | Exercised by                                  | Notes                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV=development` + `E2E_TEST=1`, plain HTTP | `e2e` job (3 shards), `./scripts/test-e2e.sh` | The main suite. Dev `trustedOrigins`, in-memory KV and secondary storage, `/__test/*` mounted, Better Auth rate limiting relaxed.          |
| `NODE_ENV=production`, no `E2E_TEST`, plain HTTP  | `e2e-prod-config` job (`prod-config.spec.ts`) | Empty `trustedOrigins` resolved from a required `BETTER_AUTH_URL`, Redis-backed KV and secondary storage, no support routes, Pino logging. |
| `NODE_ENV=test`                                   | `vp run test` (Vitest, PGlite)                | Unit and integration only — never boots a real server.                                                                                     |
| Real HTTPS / a TLS-terminating reverse proxy      | **Nothing**                                   | `LIBRIS_COOKIE_SECURE=1`, `Secure` cookies, `TRUST_PROXY_HEADERS=1` and forwarded-header handling are covered by unit tests at best.       |
| `NODE_ENV=development` without `E2E_TEST`         | **Nothing**                                   | The interactive dev path, including the pretty-terminal logger transport.                                                                  |

The last two rows are the standing gap. Read them before concluding that a green
matrix clears a deployment change.

### Running Tests

Playwright global setup waits for the API, clears BullMQ queue history from Redis, resets the database, bootstraps the admin, creates a regular user, signs both in, and issues each an app password through `POST /api/app-passwords`. Their sessions and app passwords are exposed to the specs through the E2E helper environment so tests can deliberately exercise either cookie or header authentication.

Docker mode runs backing services from `docker-compose.test.yml` on non-default ports to avoid colliding with a local stack: Postgres on `5433` and Redis on `6380`.

The Playwright image ships a Node older than this workspace's `engines.node` floor, so the `playwright` service's entrypoint installs the version pinned in `.node-version` via `n` before running `pnpm install`. It lands in the `playwright-node-toolchain` volume, so only the first run pays the download. CI reaches the same state differently — its Playwright container runs `setup-vp` with `node-version-file`. Bump `.node-version` and both paths follow; no compose edit needed.

**Docker mode (recommended):**

```bash
./scripts/test-e2e.sh                       # all tests
./scripts/test-e2e.sh --grep @smoke         # smoke only
./scripts/test-e2e.sh tests/e2e/auth.spec.ts  # single file
```

**Dev-server mode (faster iteration):**

```bash
docker compose -f docker-compose.test.yml up -d --wait
cp .env.test.example .env.test
vp run -F @libris/e2e e2e                          # all tests
cd tests/e2e && vp exec playwright test --grep @smoke   # smoke only
cd tests/e2e && vp exec playwright test --ui            # interactive Playwright UI
```

### Infrastructure

| File                      | Purpose                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `playwright.config.ts`    | Config: 1 worker, retries in CI, reporters, webServer auto-start, two setup projects. `E2E_PROD_CONFIG=1` collapses it to the single `prod-config` project                           |
| `global-setup.ts`         | Waits for API health, resets DB (delete all rows), seeds admin + regular-user keys. Stops after the reset under `E2E_PROD_CONFIG=1` — that run has no support routes to seed through |
| `auth.setup.ts`           | `setup` project — logs in the admin key via API, saves session to `.auth/user.json`                                                                                                  |
| `user-auth.setup.ts`      | `user-setup` project — logs in the non-admin `E2E_USER_API_KEY`, saves `.auth/regular-user.json` for multi-user tests                                                                |
| `fixtures.ts`             | Custom fixtures: `authedPage` (pre-authenticated page)                                                                                                                               |
| `helpers/index.ts`        | `seedOrganizedBook()`, `deleteAllBooks()`, `waitForJob()`, `goPath()`, etc.                                                                                                          |
| `helpers/resolve-urls.ts` | `requireDatabaseUrl()` / `requireRedisUrl()` — DB/Redis URL resolution used by `global-setup.ts`                                                                                     |

### Database Seeding

Tests seed data via direct PostgreSQL queries (not API calls), using the `postgres` client from `helpers/index.ts`. Each spec's `beforeEach` cleans up its own data.

### Debugging

- Screenshots/videos/traces on failure: `tests/e2e/test-results/`
- HTML report: `tests/e2e/playwright-report/index.html`
- Debug mode: `PWDEBUG=1 ./scripts/test-e2e.sh -g "test name"`

## API Exploration (Bruno)

The ignored `bruno/` directory contains a [Bruno](https://www.usebruno.com/) API collection auto-generated from the OpenAPI spec. Generate it locally with `vp run bruno:import` before using it for manual testing and exploration.

### Opening the Collection

**GUI:** Open Bruno → **Open Collection** → select the `bruno/` folder → pick the **Local** environment from the top-right dropdown.

**CLI:**

```bash
bru run --env Local bruno/            # Run all requests
bru run --env Local bruno/library/    # Run a specific folder
bru run --env Local bruno/health/     # Quick health check
```

### Environments

| Environment | File                           | Base URL                |
| ----------- | ------------------------------ | ----------------------- |
| Local       | `bruno/environments/Local.yml` | `http://localhost:3000` |

Requests use <code v-pre>{{baseUrl}}</code> for the server and inherit collection-level Bearer
authentication from <code v-pre>{{apiKey}}</code>. Set `apiKey` to an app password issued from
**Settings → Connections**; browser session cookies are not needed for Bruno.

### Regenerating the Collection

When API routes change, regenerate the collection from the OpenAPI spec:

```bash
vp run bruno:import
```

This runs `scripts/bruno-import.sh` which:

1. Starts the Hono dev server if not already running (DB/Redis not required)
2. Fetches the OpenAPI spec from `/_docs/openapi.json`
3. Imports into `bruno/` grouped by OpenAPI tags
4. Removes internal/test endpoints
5. Preserves existing environment files
6. Configures inherited `Authorization: Bearer {{apiKey}}` authentication

The generated collection is not committed. Run `vp run bruno:import` after cloning and whenever the API routes change.

### Structure

Requests are organized by OpenAPI tag into folders:

| Folder            | Endpoints                                            |
| ----------------- | ---------------------------------------------------- |
| `auth/`           | First-run setup status and bootstrap (`/api/setup`)  |
| `app-passwords/`  | Mint, list, and revoke app passwords                 |
| `books/`          | Approve metadata, delete, get candidates             |
| `credentials/`    | Service credential management                        |
| `dashboard/`      | Dashboard data                                       |
| `hardcover/`      | Sync status, trigger sync, sync log                  |
| `health/`         | Health check                                         |
| `inbox/`          | List, get, upload, rescan, cover images, status      |
| `jobs/`           | Queue status, failed jobs, retry                     |
| `library/`        | List, get, update, covers, downloads, refetch, reorg |
| `Reading_Status/` | Status counts, filtered lists                        |
| `search/`         | Command palette suggestions                          |
| `settings/`       | Get/update settings                                  |
| `stats/`          | Reading statistics                                   |

## Unit Tests (Vitest)

- **API service config:** `services/api-hono/vite.config.ts` (`test` block — PGlite in-memory DB, mocked env)
- **Web app config:** `apps/web/vite.config.ts` (`vue()`-only plugin set under `process.env.VITEST` so `shallowMount` sees raw `.u-badge` HTML instead of stubbed components)
- **Run:** `vp run test` (root aggregator, recursive across workspaces) or `vp run -F @libris/api-hono test` (API only)

Test config lives in each workspace's `vite.config.ts` `test` block, per Vite+ guidance — there are no `vitest.config.ts` files.

### API Unit/Integration Test Files

Paths relative to `services/api-hono/`. Test DB uses in-memory PGlite with mocked BullMQ queues.

| File                                                | Coverage                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/db/db.test.ts`                                 | Database schema, migrations, and query helpers                            |
| `src/env.test.ts`                                   | Environment variable parsing (Redis URL, required vars, defaults)         |
| `src/lib/epub/embed-metadata.test.ts`               | EPUB metadata embedding (OPF rewriting)                                   |
| `src/lib/hardcover/client.test.ts`                  | Hardcover GraphQL client (request shaping, response mapping)              |
| `src/lib/hardcover/matching.test.ts`                | Hardcover ISBN / title matching for sync linkage                          |
| `src/lib/hardcover/pull-status.test.ts`             | Pulling existing Hardcover reading statuses (DNF → paused mapping)        |
| `src/lib/languages.test.ts`                         | Canonical ISO 639-1 language normalization (aliases, BCP-47, 639-2/3)     |
| `src/lib/metadata/clients/metadata-clients.test.ts` | External metadata API clients (MSW mocked)                                |
| `src/lib/metadata/detect-language.test.ts`          | Content-based language detection (tinyld)                                 |
| `src/lib/metadata/extractors/epub.test.ts`          | EPUB metadata extraction (OPF parsing, cover detection)                   |
| `src/lib/metadata/sanitize.test.ts`                 | HTML stripping and metadata field sanitization                            |
| `src/lib/progress-aggregate.test.ts`                | Per-device reading-progress aggregation                                   |
| `src/lib/reading-aggregate.test.ts`                 | Per-(user, book) reading aggregate derivation                             |
| `src/lib/reading-status.test.ts`                    | Reading status derivation from KoSync progress                            |
| `src/lib/socket-guard.test.ts`                      | WebSocket connection auth guard                                           |
| `src/middleware/rate-limit.test.ts`                 | Per-IP tiered rate limiting (auth / keyCreation / general)                |
| `src/routes/api/books.test.ts`                      | `/api/books/*` approve, delete, candidates (integration)                  |
| `src/routes/api/hardcover.test.ts`                  | `/api/hardcover/*` search, sync status, trigger, log (integration)        |
| `src/routes/api/inbox.test.ts`                      | `/api/inbox/*` list, detail, approve, delete (integration)                |
| `src/routes/api/library.test.ts`                    | `/api/library/*` list, detail, covers, downloads (integration)            |
| `src/routes/api/settings.test.ts`                   | `/api/settings/*` get/update including combined status endpoint           |
| `src/routes/opds.test.ts`                           | OPDS feed endpoints (integration, Hono test client + PGlite)              |
| `src/services/queue-diagnostics.test.ts`            | BullMQ aggregation for home/settings diagnostics                          |
| `src/services/settings.test.ts`                     | App settings service CRUD                                                 |
| `src/shared/checksum.test.ts`                       | File checksum helpers used by the ingestion pipeline                      |
| `src/shared/kosync-auth.test.ts`                    | KoSync header-based auth (`x-auth-user` / `x-auth-key`)                   |
| `src/shared/request-ip.test.ts`                     | Trusted-proxy chain validation, IPv6 `/64` buckets, and auth IP injection |
| `src/shared/route-policy.test.ts`                   | Route auth policy lookup table (public/api-key/admin/opds/kosync)         |
| `src/workers/book-detected.test.ts`                 | `BOOK_DETECTED` worker: checksum, format detect, dedup                    |
| `src/workers/book-fetch-metadata.test.ts`           | `BOOK_FETCH_METADATA` worker: Hardcover lookup, promote to review         |
| `src/workers/book-parse-file.test.ts`               | `BOOK_PARSE_FILE` worker: metadata extraction orchestration               |
| `src/workers/cleanup-orphaned-files.test.ts`        | Scheduled orphan-file cleanup worker                                      |

### Web Unit Test Files

Paths relative to `apps/web/`. There is no `vitest.config.ts`; config lives in the `apps/web/vite.config.ts` `test` block, which applies the `vue()` plugin only under `process.env.VITEST` (so `shallowMount` sees raw HTML instead of stubbed components).

| File                                         | Coverage                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| `src/components/MetadataFieldPicker.test.ts` | Field-by-field candidate picker logic and validation |

When reproducing queue/admin diagnostics issues against local dev servers, clear Redis queue history as well as Postgres state:

```bash
vp run -F @libris/api-hono reset:bullmq
```

That command deletes only Libris BullMQ keys, which keeps Home and Settings queue diagnostics aligned with a fresh local reset.

## CI Pipeline

See [ci-cd.md](ci-cd.md) for the full CI workflow. Summary:

- **PRs:** `@smoke` E2E tests (3 shards), plus the whole `e2e-prod-config` job
- **main push:** Full E2E suite, plus `e2e-prod-config`
- Results are surfaced by GitHub's native checks UI. A failure uploads the
  Playwright report, the traces, and the API server log.
