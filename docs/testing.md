# Testing

## E2E Tests (Playwright)

~137 spec test bodies across 16 spec files in `tests/e2e/`, running sequentially (1 worker, shared database). 10 OPDS tests are skipped at runtime via `test.describe.skip()` (ported to Vitest integration tests), so ~127 actually execute. Regenerate the exact counts with `vp exec playwright test --list` (run from `tests/e2e/`) rather than hand-counting; the setup projects add 3 more test bodies on top of the spec total.

### Test Files

| File                       | Tests | Tags             | Coverage                                                                                                                              |
| -------------------------- | ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`             | 7     | @smoke           | Setup form, login, logout, session persistence                                                                                        |
| `book-progress.spec.ts`    | 3     | @smoke           | Multi-device progress, empty state, finished badge                                                                                    |
| `command-palette.spec.ts`  | 3     | —                | Global search modal, navigation, book results                                                                                         |
| `errors.spec.ts`           | 8     | @smoke / @slow   | Auth Error Handling (3 @smoke), Error Toasts & Edge Cases (4 @smoke); Duplicate File Detection (1 @slow + @external)                  |
| `hardcover.spec.ts`        | 10    | @smoke           | Token CRUD, status, sync button/log, feature toggles, persistence                                                                     |
| `home.spec.ts`             | 6     | @smoke           | Dashboard stats, currently reading, recently added, wide-screen card constraints                                                      |
| `inbox.spec.ts`            | 16    | @smoke           | List, search, pagination, empty state, metadata picker, approve, delete                                                               |
| `ingestion.spec.ts`        | 1     | @slow @external  | Full EPUB pipeline: detect → parse → review → approve → library                                                                       |
| `library.spec.ts`          | 18    | @smoke           | Grid/list view, filters, search, pagination, detail page, covers, downloads                                                           |
| `multi-user-auth.spec.ts`  | 15    | —                | Ownership enforcement, admin vs regular key, cross-user 403s, credential rotation                                                     |
| `multi-user.spec.ts`       | 11    | —                | Per-user data isolation (reading progress, stats, service credentials)                                                                |
| `opds.spec.ts`             | 10    | @smoke (skipped) | Feed structure, search, covers, downloads, Basic auth (`test.describe.skip`)                                                          |
| `reading-status.spec.ts`   | 8     | @smoke           | Sidebar links, status tabs, empty state, wide-screen cards, plus a parametrized loop covering the reading/finished/unread/paused tabs |
| `settings.spec.ts`         | 8     | @smoke (4)       | Health & diagnostics (@smoke); jobs browser and queue management untagged                                                             |
| `stats.spec.ts`            | 7     | @smoke           | Books finished, streaks, daily activity, genre distribution                                                                           |
| `websocket-events.spec.ts` | 6     | —                | Realtime event bus over WebSocket — job status, pipeline events, Hardcover sync updates                                               |

> **Note:** `opds.spec.ts` uses `test.describe.skip()` — the OPDS tests have been ported to
> Vitest integration tests at `services/api-hono/src/routes/opds.test.ts`. The E2E versions
> are retained for optional live-server testing but do not run by default.

### Tags

| Tag         | Count       | Meaning                                                                                                                                     |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@smoke`    | 96 / 86 run | Critical paths — runs on PRs via `--grep @smoke`. `--list` reports 96 tagged bodies; 10 are the skipped OPDS tests, so 86 actually execute. |
| `@slow`     | 2           | File processing / queue waits                                                                                                               |
| `@external` | 2           | Requires external API access (Hardcover in practice)                                                                                        |
| _untagged_  | 39          | Run on main push (full suite) but skipped on PR smoke runs                                                                                  |

Untagged specs (command palette, multi-user flows, WebSocket events) validate behavior that doesn't need to block every PR but must pass on main.

### Running Tests

Playwright global setup waits for the API, clears BullMQ queue history from Redis, resets the database, and then seeds two API keys so queue/admin diagnostics start from a deterministic state: an admin key (via `POST /api/auth/setup`, exposed as `E2E_API_KEY`) and a non-admin regular-user key (via `POST /api/auth/keys`, exposed as `E2E_USER_API_KEY`). Both seeders fall back to direct database insertion (bcryptjs + `postgres`) when the endpoint is rate-limited (429). The multi-user suites depend on both keys being present.

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

| File                      | Purpose                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`    | Config: 1 worker, retries in CI, reporters, webServer auto-start, two setup projects                                  |
| `global-setup.ts`         | Waits for API health, resets DB (delete all rows), seeds admin + regular-user keys                                    |
| `auth.setup.ts`           | `setup` project — logs in the admin key via API, saves session to `.auth/user.json`                                   |
| `user-auth.setup.ts`      | `user-setup` project — logs in the non-admin `E2E_USER_API_KEY`, saves `.auth/regular-user.json` for multi-user tests |
| `fixtures.ts`             | Custom fixtures: `authedPage` (pre-authenticated page)                                                                |
| `helpers/index.ts`        | `seedOrganizedBook()`, `deleteAllBooks()`, `waitForJob()`, `goPath()`, etc.                                           |
| `helpers/resolve-urls.ts` | `requireDatabaseUrl()` / `requireRedisUrl()` — DB/Redis URL resolution used by `global-setup.ts`                      |

### Database Seeding

Tests seed data via direct PostgreSQL queries (not API calls), using the `postgres` client from `helpers/index.ts`. Each spec's `beforeEach` cleans up its own data.

### Debugging

- Screenshots/videos/traces on failure: `tests/e2e/test-results/`
- HTML report: `tests/e2e/playwright-report/index.html`
- Debug mode: `PWDEBUG=1 ./scripts/test-e2e.sh -g "test name"`

## API Exploration (Bruno)

The `bruno/` directory contains a [Bruno](https://www.usebruno.com/) API collection auto-generated from the OpenAPI spec. It provides a ready-to-use set of all API endpoints for manual testing and exploration.

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
| Local       | `bruno/environments/Local.bru` | `http://localhost:3000` |

Requests use a <code v-pre>{{baseUrl}}</code> variable which resolves from the selected environment.

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

The collection is committed to git so it's available immediately after cloning.

### Structure

Requests are organized by OpenAPI tag into folders:

| Folder            | Endpoints                                            |
| ----------------- | ---------------------------------------------------- |
| `auth/`           | Setup, API key CRUD                                  |
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

| File                                                | Coverage                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `src/db/db.test.ts`                                 | Database schema, migrations, and query helpers                        |
| `src/env.test.ts`                                   | Environment variable parsing (Redis URL, required vars, defaults)     |
| `src/lib/epub/embed-metadata.test.ts`               | EPUB metadata embedding (OPF rewriting)                               |
| `src/lib/hardcover/client.test.ts`                  | Hardcover GraphQL client (request shaping, response mapping)          |
| `src/lib/hardcover/matching.test.ts`                | Hardcover ISBN / title matching for sync linkage                      |
| `src/lib/hardcover/pull-status.test.ts`             | Pulling existing Hardcover reading statuses (DNF → paused mapping)    |
| `src/lib/languages.test.ts`                         | Canonical ISO 639-1 language normalization (aliases, BCP-47, 639-2/3) |
| `src/lib/metadata/clients/metadata-clients.test.ts` | External metadata API clients (MSW mocked)                            |
| `src/lib/metadata/detect-language.test.ts`          | Content-based language detection (tinyld)                             |
| `src/lib/metadata/extractors/epub.test.ts`          | EPUB metadata extraction (OPF parsing, cover detection)               |
| `src/lib/metadata/sanitize.test.ts`                 | HTML stripping and metadata field sanitization                        |
| `src/lib/progress-aggregate.test.ts`                | Per-device reading-progress aggregation                               |
| `src/lib/reading-aggregate.test.ts`                 | Per-(user, book) reading aggregate derivation                         |
| `src/lib/reading-status.test.ts`                    | Reading status derivation from KoSync progress                        |
| `src/lib/socket-guard.test.ts`                      | WebSocket connection auth guard                                       |
| `src/middleware/rate-limit.test.ts`                 | Per-IP tiered rate limiting (auth / keyCreation / general)            |
| `src/routes/api/books.test.ts`                      | `/api/books/*` approve, delete, candidates (integration)              |
| `src/routes/api/hardcover.test.ts`                  | `/api/hardcover/*` search, sync status, trigger, log (integration)    |
| `src/routes/api/inbox.test.ts`                      | `/api/inbox/*` list, detail, approve, delete (integration)            |
| `src/routes/api/library.test.ts`                    | `/api/library/*` list, detail, covers, downloads (integration)        |
| `src/routes/api/settings.test.ts`                   | `/api/settings/*` get/update including combined status endpoint       |
| `src/routes/opds.test.ts`                           | OPDS feed endpoints (integration, Hono test client + PGlite)          |
| `src/services/queue-diagnostics.test.ts`            | BullMQ aggregation for home/settings diagnostics                      |
| `src/services/settings.test.ts`                     | App settings service CRUD                                             |
| `src/shared/checksum.test.ts`                       | File checksum helpers used by the ingestion pipeline                  |
| `src/shared/kosync-auth.test.ts`                    | KoSync header-based auth (`x-auth-user` / `x-auth-key`)               |
| `src/shared/request-ip.test.ts`                     | Client IP extraction with and without `TRUST_PROXY_HEADERS`           |
| `src/shared/route-policy.test.ts`                   | Route auth policy lookup table (public/api-key/admin/opds/kosync)     |
| `src/workers/book-detected.test.ts`                 | `BOOK_DETECTED` worker: checksum, format detect, dedup                |
| `src/workers/book-fetch-metadata.test.ts`           | `BOOK_FETCH_METADATA` worker: Hardcover lookup, promote to review     |
| `src/workers/book-parse-file.test.ts`               | `BOOK_PARSE_FILE` worker: metadata extraction orchestration           |
| `src/workers/cleanup-orphaned-files.test.ts`        | Scheduled orphan-file cleanup worker                                  |

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

- **PRs:** `@smoke` E2E tests only
- **main push:** Full E2E suite
- Test results posted as PR comments
