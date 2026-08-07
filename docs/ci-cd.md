# CI/CD

Two GitHub Actions workflows:

- `.github/workflows/ci.yml` — quality gates and tests. Runs on push to main and PRs to main.
- `.github/workflows/release.yml` — the changesets version PR, GHCR image publishing, and GitHub Releases.

All jobs run on `ubuntu-latest`.

## Caching strategy

This repo is orchestrated by Vite+ (the `vp` CLI), not Turbo or a standalone pnpm install step. CI caching has two layers:

- **Dependencies** — handled by `voidzero-dev/setup-vp@v1` with `cache: true`. The action provisions Node (pinned via `node-version-file: .node-version`) plus pnpm, restores the dependency cache, and runs `vp install`. There is no separate `actions/cache` step for the pnpm store.
- **Vite+ task cache** — each of `check`, `test`, `build`, and `deploy-docs` adds one `actions/cache@v4` step for the path `node_modules/.vite/task-cache`, keyed per job, OS, and commit SHA, with `restore-keys` falling back to the base branch (or `main`) and then any prior run for that job and OS. This replays per-package task outputs across runs when inputs are unchanged — the rough equivalent of a remote build cache.

The key scheme follows [Vite+'s GitHub Actions cache guide](https://viteplus.dev/guide/github-actions-cache):

```yaml
key: vp-task-<job>-${{ runner.os }}-${{ runner.arch }}-${{ github.run_id }}-${{ github.run_attempt }}
restore-keys: |
  vp-task-<job>-${{ runner.os }}-${{ runner.arch }}-
```

Why it is shaped this way:

- **`runner.os` + `runner.arch`** — task outputs and native tools are platform-specific.
- **`github.run_id` + `github.run_attempt`** — Actions cache entries are immutable, so the primary key must be unique per attempt. A per-commit key (`github.sha`) means re-running the same commit can never save a new entry.
- **Task inputs are deliberately absent from the key.** Sources and the lockfile are fingerprinted by Vite Task itself; putting them in the Actions key makes GitHub skip otherwise-useful restores before Vite Task gets to decide which tasks still hit.
- **The per-job prefix is a local addition.** Every job in a run shares one `run_id`, so a single shared key would have the jobs collide when saving.

Restore must happen **after** `setup-vp`, because installing dependencies rewrites `node_modules`.

::: warning Experimental, and worth measuring
Upstream flags cross-run reuse of the Vite Task cache as experimental. Restore and save add their own overhead, so for fast tasks it can cost more than it saves — measure before assuming it helps.

GitHub also caps each repository at **10 GB** of Actions cache with LRU eviction, and the per-attempt primary key means every run writes a new entry. The `restore-keys` prefix still finds the newest compatible entry, but if hit rates look poor this is the first thing to examine.
:::

`actions/checkout@v4` uses `fetch-depth: 0`. Jobs run their task recursively across all packages with `vp run --cache -r <task>` (the `check` job adds `-v`). Skipping unchanged work comes from the task-cache replay, not from an affected-graph filter — there is no `--affected` flag in the workflow.

### Concurrency

`ci.yml` sets `concurrency: ci-<workflow>-<ref>` with `cancel-in-progress: true`, so a force-push or a rapid follow-up commit cancels the superseded run instead of leaving an e2e matrix burning runners.

### Shared build artifact

The `build` job runs once, produces `apps/web/dist/` and `services/api-hono/dist/`, and tars up the fully-materialized `node_modules/` with all its `.pnpm/` virtual store links. It publishes the tarball as `build-output-<sha>` via `actions/upload-artifact@v4`. The e2e shards download it via `actions/download-artifact@v4` and extract it, so they skip both install and build — they run `setup-vp` with `run-install: false`.

### E2E sharding

`e2e` is matrix-sharded (`shard: ["1/3", "2/3", "3/3"]`) so the Playwright suite runs in parallel across three shards. `fail-fast: false` — a failure in one shard does not cancel the others.

## Jobs (ci.yml)

### 1. check

Code quality gate — runs on every trigger.

1. Set up Vite+ via `voidzero-dev/setup-vp@v1` with `node-version-file: .node-version` and `cache: true` (provisions Node + pnpm, restores deps, runs `vp install`).
2. Restore the Vite+ task cache (`actions/cache@v4`, path `node_modules/.vite/task-cache`).
3. Run `vp run --cache -r -v check` — format + lint + typecheck across all packages. The docs workspace runs only fmt + lint here; the full VitePress build that catches missing pages, invalid frontmatter, and bad links runs in the `build` job and in `deploy-docs`, not in `check`. Vite Task replays cached steps for unchanged packages.

### 2. test

Unit tests — runs on every trigger.

1. Set up Vite+ (`setup-vp@v1`, `cache: true`).
2. Restore the Vite+ task cache (`actions/cache@v4`).
3. Run `vp run --cache -r test` — Vite Task fingerprints inputs per package, so unchanged packages replay from cache.

### 3. build

Shared prerequisite for the e2e job — runs once after `check` passes. Builds every workspace project with `vp run --cache -r build` (api + web + docs) and publishes a `build-output-<sha>` artifact containing:

- Root `node_modules/` (fully materialized with pnpm's `.pnpm/` virtual store)
- `apps/web/node_modules/` and `apps/web/dist/`
- `services/api-hono/node_modules/` and `services/api-hono/dist/`
- `tests/e2e/node_modules/` (Playwright workspace)
- `docs/node_modules/` (the tar command has a fallback that omits `docs/node_modules` if it is absent)

Retention is 1 day (intermediate build artifact, not a release asset).

### 4. e2e

Playwright end-to-end tests — runs on both PRs and pushes to main, depends on `build`.

**Container:** `mcr.microsoft.com/playwright:v1.60.0-jammy` — Microsoft's official Playwright image with browsers + system deps pre-installed. The Playwright version is pinned in `pnpm-workspace.yaml` under the catalog (`@playwright/test: 1.60.0`); `tests/e2e/package.json` references it as `catalog:`. When upgrading Playwright, bump the workspace catalog and the `ci.yml` container tag in lockstep. (`docker-compose.test.yml` uses the `-noble` variant, `v1.60.0-noble`, for the local Playwright service.)

**Services:** PostgreSQL 17 + Redis 7 (inline service containers, each with a health check — `pg_isready` / `redis-cli ping` — with a 2s interval).

**Scope:** one job handles both triggers so the service, container, and env setup cannot drift between them:

- On `pull_request` — the `@smoke` subset, for fast feedback.
- On `push` to main — the full suite, no tag filter.

**Artifacts:**

- Playwright HTML report — `e2e-report-<idx>` (always uploaded, 7-day retention).
- Test results (screenshots, videos, traces) — `e2e-test-results-<idx>` (uploaded on failure, 7-day retention).

`<idx>` is `strategy.job-index`. Artifacts use `actions/upload-artifact@v4`, whose names must be unique within a run — hence the per-shard index.

Pass/fail is surfaced by GitHub's native checks UI on the PR; there is no bot comment.

### 5. deploy-docs

Deploys VitePress documentation to Cloudflare Pages — runs on push to main only, depends on `check` passing.

1. Gate step: `git diff --name-only HEAD^ HEAD` — skip the rest of the job when the push doesn't touch `docs/`, `pnpm-lock.yaml`, `vite.config.ts`, or any root `package.json`.
2. Set up Vite+ (`setup-vp@v1`, `cache: true`) and restore the Vite+ task cache (`actions/cache@v4`).
3. Build docs (`vp run --cache -F @libris/docs build`, which also runs `@libris/api-hono#build:spec` for the OpenAPI spec via dependsOn) — replayed from Vite Task cache when unchanged.
4. Deploy `docs/.vitepress/dist` via `vp exec wrangler pages deploy`.

**Secrets required:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`

## Environment Variables (CI)

Set on the `e2e` job:

```
CI=true
NODE_ENV=development
E2E_TEST=1
LIBRIS_COOKIE_SECURE=0
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=libris_test
POSTGRES_PASSWORD=libris_test
POSTGRES_DB=libris_test
REDIS_HOST=redis
REDIS_PORT=6379
LIBRIS_INBOX_PATH=/tmp/e2e-inbox
LIBRIS_LIBRARY_PATH=/tmp/e2e-library
API_SECRET_KEY=<openssl rand -hex 32>
BETTER_AUTH_SECRET=<openssl rand -hex 32>
TEST_ROUTE_TOKEN=<openssl rand -hex 32>
MIGRATIONS_PATH=./services/api-hono/migrations
LIBRIS_API_LOG=/tmp/e2e-api.log
```

Four of those are easy to get wrong and each one is fatal rather than flaky:

- **`NODE_ENV`** has no default in `services/api-hono/src/env.ts`. Omit it and
  `getEnv()` throws a `ZodError` before the server binds a port, so Playwright's
  `webServer` times out after 60s and every shard fails without running a test.
  The value must match `docker-compose.test.yml` (`development`) so the two
  harnesses exercise the same branches. It must **not** be `production`:
  `bootstrap.ts` throws `E2E_TEST=1 is not allowed in NODE_ENV=production`. The
  production config is covered by its own job, `e2e-prod-config`.
- **`TEST_ROUTE_TOKEN`** authenticates the `/__test/*` support routes that seed
  books, clear caches and emit events. `tests/e2e/helpers/index.ts` throws
  outright when it is unset, and `src/middleware/auth.ts` rejects any token
  shorter than 32 bytes — a short value silently 401s every support-route call
  rather than reporting a config error.
- **`API_SECRET_KEY` / `BETTER_AUTH_SECRET`** are validated at startup:
  published placeholders and low-diversity strings are rejected. Generate CI's
  throwaway values with `openssl rand -hex 32` like any other, so a future
  tightening of the validator does not take CI down with it.
- **`LIBRIS_API_LOG`** is Libris-specific, not a framework variable. When it is
  set, `tests/e2e/playwright.config.ts` tees the API process's stdout/stderr to
  that path so a failing shard can upload it (`e2e-api-log-<idx>`).

## Release (release.yml)

Releases are driven by [changesets](https://github.com/changesets/changesets). The flow is PR-gated rather than manually dispatched.

### How a release happens

1. **You add a changeset** with your PR — `pnpm changeset`, or hand-write `.changeset/<name>.md`. Every code change needs one, or nothing will ever be released.
2. **Your PR merges to main.** The `version` job runs `changesets/action@v1`, which consumes every `.changeset/*.md`, bumps versions, rewrites the CHANGELOGs, and opens (or updates) a **"chore: version packages"** pull request.
3. **You review and merge that version PR.** This is the actual release gate.
4. **The merge lands the bumped versions on main**, and the `publish` job builds the image and cuts the releases.

### version job

Runs on push to main. Uses `changesets/action@v1` **without a `publish` input** — that input drives npm publishing, and nothing here goes to npm (every workspace is private; `.changeset/config.json` sets `access: restricted`). The action is used purely to maintain the version PR.

`.changeset/config.json` puts `@libris/web`, `@libris/api-hono`, and `@libris/docs` in a `fixed` group, so they always bump together. `@libris/e2e` is ignored.

**Permissions:** `contents: write`, `pull-requests: write`.

::: warning CI on the version PR needs manual approval
The version PR is opened by `github-actions[bot]`. GitHub creates the `ci.yml` run for it but holds it in **`action_required`** with zero jobs executed, pending approval — the same gate it applies to workflow runs on pull requests from bots and first-time contributors.

Approve it with the **"Approve and run"** button on the PR's checks tab, or from the CLI:

```bash
gh api -X POST repos/RazorSiM/libris/actions/runs/<run-id>/approve
```

Once approved the run executes and reports normally, so required status checks on `main` do **not** permanently deadlock the version PR — but every release costs one approval before the PR becomes mergeable.

The image build is unaffected either way: merging produces an ordinary push event, and `release.yml` runs ungated.
:::

### publish job

Runs on every push to main, but is a **no-op unless the version actually changed**. It reads the current versions out of `services/api-hono/package.json` and `apps/web/package.json`, derives the composite tag `v<api-version>-web<web-version>`, and runs `docker manifest inspect` against GHCR. If that tag already exists, the job stops there. This is why no commit-message sniffing is needed to detect "the version PR just merged" — a new version simply produces a tag that isn't in the registry yet.

When a build is needed it uses `docker/setup-buildx-action@v3` + `docker/build-push-action@v6` with `cache-from`/`cache-to: type=gha`, pushing both `:<tag>` and `:latest`.

Only when an image was actually published does it create the git tags (`api-hono/v<version>`, `web/v<version>`) and GitHub Releases via `gh release create`, with each release body extracted from that package's `CHANGELOG.md`. Existing releases are skipped, so re-runs are idempotent.

**Registry auth:** `docker/login-action@v3` against `ghcr.io` using the built-in `GITHUB_TOKEN` with `packages: write`. There is no separate registry token to manage.

**Image produced:** `ghcr.io/RazorSiM/libris:v<api-version>-web<web-version>` and `:latest`.

**Manual override:** `workflow_dispatch` accepts a `force_publish` boolean that rebuilds and pushes even when the tag already exists.

::: tip First publish
The first push to GHCR creates the package as **private**, regardless of repository visibility. It must be made public separately, or production pulls will fail with an auth error.
:::

See [docs/deployment.md](deployment.md) for production usage.

## Docker Test Services

`docker-compose.test.yml` for local testing:

| Service       | Port | Config                           |
| ------------- | ---- | -------------------------------- |
| PostgreSQL 17 | 5433 | DB: `libris_test`, tmpfs storage |
| Redis 7       | 6380 | Default storage                  |

PostgreSQL uses tmpfs for fast ephemeral storage. Redis uses its default in-memory store.
