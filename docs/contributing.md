# Contributing

## Prerequisites

- **Node.js 26** — install via [fnm](https://github.com/Schniz/fnm) or [mise](https://mise.jdx.dev). The repo has a `.node-version` file (pinned to `26.5.0`) that both tools pick up automatically. `package.json` sets `engines.node` to `>=26.0.0`, so any 26.x works; the pin is what CI and the E2E container provision.
- **pnpm 11.x** — `npm install -g pnpm` or let mise/fnm handle it. The repo pins `packageManager` to `pnpm@11.5.0`.
- **Docker** — for Postgres 17 + Redis 7 (recommended), or install them locally. Postgres must have the `pg_trgm` extension available; the schema uses trigram and full-text GIN indexes.

## Setup

```bash
git clone <repo-url>
cd libris
pnpm install
cp .env.example .env   # defaults match the Docker compose below
```

Start Postgres and Redis:

```bash
docker compose -f docker-compose.dev.yml up -d
```

Data is persisted to `./tmp/postgres` and `./tmp/redis` (gitignored). To wipe state, stop the stack and delete those directories.

Start both servers:

```bash
vp run -F @libris/api-hono dev   # API on port 3000
vp run -F @libris/web dev        # SPA on port 3100
```

On first visit, the settings page prompts you to create an API key.

## Project Structure

```
apps/web/               Vue 3 SPA frontend (built with Vite+/vp)
services/api-hono/      Hono API backend
tests/e2e/              Playwright E2E tests
docs/                   VitePress documentation
scripts/                Build and test helpers
```

The frontend is a Vue 3 single-page app. `@nuxt/ui` provides the component library, but there is no `nuxt` dependency — routing is file-based via vue-router (unplugin-vue-router) and the data layer is Pinia + Pinia Colada.

See [architecture.md](architecture.md) for how the pieces connect.

## Toolchain

The monorepo is orchestrated by **Vite+** (the `vp` CLI), which wraps Vite/Rolldown, Vitest, tsdown, Oxlint, and Oxfmt. pnpm is still the package manager, driven by `vp install`. There is no Turborepo.

Related tooling used in day-to-day work:

- **GitHub + the `gh` CLI** — pull requests and issues live on GitHub. Use `gh pr create`, `gh pr checks <id> --watch`, etc.
- **bd/beads** — local, per-user issue tracker. The `.beads/` directory is git-ignored, so issues are never shared via the repo.
- **Bruno API collection** — `bruno/` holds an API collection generated from the OpenAPI spec. Regenerate it with `vp run bruno:import`, or run requests with `bru run --env Local bruno/`.

## Development Workflow

### Running checks

```bash
vp run check                       # Format + lint + typecheck (all packages)
vp run test                        # Unit tests (root, recursive)
vp run -F @libris/api-hono test    # API integration tests (PGlite, no external DB needed)
vp run -F @libris/e2e e2e          # E2E tests (requires dev servers running)
```

Always run `vp run check` before pushing. CI runs the same checks. `vp run check` runs format, lint, and typecheck only — it does not build the docs. The docs workspace check is fmt + lint over Markdown; the full `vitepress build` (which fails on broken links, missing pages, or invalid frontmatter) runs in the CI build job and the docs deploy step, not in `vp run check`.

### Adding an API endpoint

1. Define the route with `createRoute` from `@hono/zod-openapi` in `services/api-hono/src/routes/api/`
2. Add Zod schemas for request/response in `services/api-hono/src/shared/schemas.ts`
3. The `hc` client on the frontend automatically picks up the new route — no codegen step
4. Verify the OpenAPI docs at `http://localhost:3000/_docs/scalar`

Authentication is policy-driven. `services/api-hono/src/shared/route-policy.ts` maps request paths to an auth policy (`public`, `optional`, `api-key`, `admin`, `opds`, `kosync`, or `skip`); first match wins and the default for `/api/` routes is `api-key`. Admin-only prefixes (e.g. `/api/jobs`) are marked `admin` in that table. For finer-grained checks inside a handler, use the guards in `services/api-hono/src/shared/auth.ts`: `requireAdmin(c)` for admin-only actions and `requireBookOwnership(...)` to gate book mutations to the uploader or an admin.

**A handler that gates on `requireAdmin(c)`, or branches on `isAdmin(c)` to widen a response, must also declare its path in `route-policy.ts`** — as policy `admin` in `ROUTE_TABLE`, or in `APP_PASSWORD_DENIED` when the same prefix legitimately serves non-admin callers too (as `/api/settings` does). An in-handler check is invisible to the middleware, so without the declaration the path resolves to plain `api-key` and an app password — the credential that sits in plaintext in a KOReader config on a device that leaves the house — reaches it carrying its owner's full authority. `route-policy.test.ts` scans the routes directory and fails if a new in-handler admin check is left undeclared; the only exemption is `isAdmin(c)` used purely to widen a `WHERE` clause, which must be listed with a reason in that test.

Migrations are applied automatically at startup by `runMigrations()` in `services/api-hono/src/bootstrap.ts` (it delegates to the drizzle-orm/postgres-js migrator in `src/db/migrate.ts`). Migrations run **before** the DB pool is created, and are skipped when `NODE_ENV=test` (the API integration tests use PGlite with manual migration).

### Working on the frontend

Pages use query composables built on `useQuery` from `@pinia/colada`:

```ts
// composables/queries/useBookDetailQuery.ts
import { useQuery } from "@pinia/colada";

export function useBookDetailQuery(id: Ref<string>) {
  const client = useApiClient();

  return useQuery({
    key: () => ["library", id.value],
    query: async () => {
      const res = await client.api.library[":id"].$get({ param: { id: id.value } });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    staleTime: 30_000,
  });
}
```

- Cover/download URLs are plain strings: `` `${config.apiBaseUrl}/api/library/${id}/cover` ``
- File uploads use `useUpload()` (XHR with progress tracking)
- Real-time events use `useServerEvents()` (WebSocket-backed, one connection per tab)

Every interactive element needs a `data-testid` attribute for E2E test stability.

### Database changes

```bash
# Edit the schema
$EDITOR services/api-hono/src/db/schema.ts

# Generate a migration
cd services/api-hono && vp exec drizzle-kit generate

# Migrations auto-apply on API startup — just restart the dev server
```

Never edit applied migrations. See [database.md](database.md) for the full schema.

### Changesets

Every code change needs a changeset before pushing:

```bash
pnpm changeset
# Select affected packages, describe the change
# Commit the .changeset/*.md file with your code
```

### E2E Tests

```bash
# With dev servers running
vp run -F @libris/e2e e2e

# Self-contained (starts its own Postgres + Redis in Docker)
vp run test:e2e:docker
```

E2E tests use Playwright with Chromium. See [testing.md](testing.md) for details.

#### Resetting local queue diagnostics

BullMQ history lives in Redis, not PostgreSQL. If you recreate the database or clear the inbox/library paths, the Home and Settings diagnostics can still show old queue completions or failed jobs until the BullMQ keys are cleared too.

For a truly fresh local reset, run:

```bash
vp run -F @libris/api-hono reset:bullmq
```

This deletes only Libris BullMQ keys for the known queues; it does not flush the entire Redis database.

#### Multi-user test patterns

The test suite supports two authenticated sessions: an **admin** and a **regular user**.

**Page fixtures** (from `tests/e2e/fixtures.ts`):

- `authedPage` / `adminPage` — admin session (loaded from `.auth/user.json`)
- `userPage` — non-admin session (loaded from `.auth/regular-user.json`, created in its own browser context)

**API-level helpers** (from `tests/e2e/helpers/index.ts`):

- `authHeaders()` — Bearer headers for the admin key
- `userAuthHeaders()` — Bearer headers for the regular-user key
- `getAdminKeyId()` — fetches the admin API key ID, useful for seeding `created_by` on books

**Gotchas when seeding data:**

- `reading_progress.api_key_id` is NOT NULL. Always include it when inserting rows — use `getAdminKeyId()` or the equivalent user key ID.
- The unique constraint on `reading_progress` is `(api_key_id, document, device)`, not `(document, device)`. ON CONFLICT clauses must target all three columns.

See `tests/e2e/multi-user-auth.spec.ts` for working examples of ownership checks, credential rotation, and cross-user 403 assertions.

## Issue-First Workflow

**Open an issue before starting work.** This applies to features, bugs, and refactors — anything non-trivial. It prevents duplicate work, makes it easy to track what's in progress, and gives others a chance to weigh in before code is written.

Use GitHub Issues (via the `gh` CLI or the web UI). Keep the title specific, describe what you're changing and why.

## AI Agents

Agents are encouraged and actively used in this project. That said, using an agent badly is worse than not using one — you still own the output.

**What good agent use looks like:**

- Open an issue first, then point the agent at it
- Read the diff before you commit it. If you wouldn't write it yourself, don't ship it
- Run `vp run check` and the relevant tests before opening a PR — the agent should do this, and you should verify it did
- Extend or add tests when the agent adds functionality; don't let it skip them
- Review for security issues: injection, auth bypass, sensitive data in logs, overly permissive configs. Agents miss these
- One PR per logical change. If the agent opens a sprawling refactor alongside a bug fix, split it

**What to avoid:**

- Iterating blindly until CI goes green without understanding why it was red
- Accepting "it works" as a substitute for "it's correct"
- Letting the agent add abstractions, helpers, or config options the task doesn't require
- Skipping the changeset because the agent forgot it

The bar for a PR is the same regardless of whether a human or agent wrote the code.

## Code Style

- **TypeScript** everywhere — strict mode enabled in all packages
- **oxfmt** for formatting, **oxlint** for linting (both run via `vp run check`)
- **Zod** for all validation — request params, response bodies, env vars
- Prefer simple code over abstractions. Three similar lines > a premature helper
- No hand-written API response types — `hc` infers them from Zod schemas

## Docker

```bash
# Build unified image (API + SPA)
docker build -t libris .
```

See [deployment.md](deployment.md) for production configuration.
