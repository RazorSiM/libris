<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.

<!--VITE PLUS END-->

# Monorepo Toolchain

This project uses **Vite+** (`vp`) as the unified toolchain — task orchestration, dev/build/preview, formatter (oxfmt), linter (oxlint), and test runner (Vitest under the hood) all live behind one CLI. **pnpm** is still the package manager (driven by `vp install`/`vp add`/`vp remove`).

Per-package config is consolidated into each `vite.config.ts` with `fmt`, `lint`, `pack`, and `test` blocks. The root `vite.config.ts` holds shared `fmt` and `lint` rules.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp run check` and `vp run test` to validate changes (root aggregator tasks; equivalent to `vp run -r check`/`-r test`).
- [ ] Import test utilities from `vite-plus/test` (the migrator rewrote `vitest`/`vitest/config` imports to this).
- [ ] Update `docs/` if your changes affect architecture, configuration, or behavior documented there.
- [ ] Add a changeset (`pnpm changeset` or create `.changeset/<name>.md`) for every code change before pushing.

# Libris — Agent Guide

Self-hosted book management system. Ingests ebooks, enriches metadata from multiple sources, organizes into a library, serves via OPDS, syncs reading progress with KoReader.

## Documentation Index

Detailed documentation lives in `docs/`. Read the relevant file before working in that area.

| Document                                     | What's Inside                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | Monorepo structure, tech stack, how pieces connect, ingestion pipeline |
| [docs/api/](docs/api/)                       | API reference (vitepress-openapi, auto-generated from OpenAPI spec)    |
| [docs/frontend.md](docs/frontend.md)         | Pages, auth flow, composables, components, keyboard shortcuts          |
| [docs/database.md](docs/database.md)         | Schema (all tables), migration workflow, commands                      |
| [docs/testing.md](docs/testing.md)           | E2E tests (Playwright), unit tests (Vitest), Bruno API collection      |
| [docs/ci-cd.md](docs/ci-cd.md)               | GitHub Actions workflows, jobs, artifacts                              |
| [docs/deployment.md](docs/deployment.md)     | Production Docker images, env vars, volumes, example compose           |
| [docs/environment.md](docs/environment.md)   | All environment variables (API, frontend, test)                        |
| [docs/contributing.md](docs/contributing.md) | Setup, workflow, code style, how to add endpoints/pages                |
| [docs/guide/](docs/guide/)                   | User guide with screenshots (VitePress site)                           |

## Quick Reference

### Development

```bash
vp install                          # Install dependencies (delegates to pnpm)
vp run -F @libris/api-hono dev      # Backend — Hono on port 3000
vp run -F @libris/web dev           # Frontend — Vue 3 + Vite+ SPA on port 3100
vp run -F @libris/docs dev          # Documentation — VitePress on port 5173
vp run check                        # Format + lint + typecheck across all packages
vp run test                         # Unit tests
vp run -F @libris/e2e e2e           # E2E tests (requires dev servers running)
vp run test:e2e:docker              # E2E tests in Docker (self-contained)
```

Per-package operations: `vp run -F @libris/<pkg> <task>`. Recursive operations: `vp run -r <task>` or the root aggregator (`vp run check` / `test` / `build`). The previous `pnpm run dev:server` / `pnpm run check` aliases were removed — use `vp run` directly.

### API Testing (Bruno)

The ignored `bruno/` directory contains a Bruno API collection auto-generated from the OpenAPI spec. Generate it locally before opening it in the Bruno GUI or running requests from the CLI.

```bash
vp run bruno:import                 # Regenerate collection from OpenAPI spec (auto-starts server)
bru run --env Local bruno/          # Run all requests from CLI
bru run --env Local bruno/health/   # Run a specific folder
```

To open in Bruno GUI: **Open Collection** → select the `bruno/` folder. Select the **Local** environment (top-right dropdown).

The collection is generated locally and is not committed to git. Run `vp run bruno:import` after cloning and whenever API routes change — environment files are preserved across re-imports.

### Database

```bash
cd services/api-hono && vp exec drizzle-kit generate  # Generate migration from schema diff
vp run -F @libris/api-hono db:studio                 # Visual DB browser
vp run -F @libris/api-hono db:reset                  # Drop + recreate the local DB
vp run -F @libris/api-hono reset:bullmq              # Clear BullMQ queues
```

**Never pass `--ignore-conflicts`.** It suppresses drizzle-kit's check that the
snapshot chain has a single leaf — which is exactly the check that catches two
migrations generated from the same parent. It hid a branched chain on this
branch until the snapshots had to be repaired by hand. If `generate` reports a
conflict, fix the chain; do not silence it.

### Releasing

```bash
pnpm changeset                  # Create a changeset (describe what changed)
# Commit the .changeset/*.md file with your PR
```

Releases are automatic and PR-gated. Once your PR merges to main, the Release
workflow opens a **"chore: version packages"** PR. Merging that PR bumps the
versions, which publishes the image to `ghcr.io/razorsim/libris` and cuts the
`api-hono/vX` + `web/vX` GitHub Releases.

### Key Architecture Rules

- **Hono** backend at `services/api-hono/`. Uses `@hono/zod-openapi` for typed routes and `vp pack` (tsdown under the hood) for builds.
- **Migrations auto-apply on startup** via `runMigrations()` in `bootstrap.ts`. Never edit applied migrations.
- **Import test utilities from `vite-plus/test`** (e.g., `import { describe, expect, it } from "vite-plus/test"`).
- **Every route MUST have OpenAPI docs** — see below.
- **Frontend components MUST have `data-testid`** — every interactive element (buttons, inputs, links, cards, status indicators) needs a `data-testid` attribute for E2E test stability. Use descriptive names like `data-testid="approve-btn"` or `data-testid="field-title"`.
- **Always run `vp run check` after code changes** — this validates format, lint, and typecheck across all packages. Run `vp run test` for unit tests and `vp run -F @libris/api-hono test` for the API integration tests only.

### OpenAPI Documentation (Required)

Every route in `services/api-hono/src/routes/` MUST use `createRoute` from `@hono/zod-openapi` with OpenAPI metadata. When adding or modifying a route, keep the schema in sync with the actual request/response shape.

```ts
import { createRoute, z } from "@hono/zod-openapi";

const route = createRoute({
  method: "get",
  path: "/api/books/{id}",
  tags: ["books"],
  summary: "Short description",
  description: "Detailed explanation of what this endpoint does.",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Book ID" }),
    }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: BookSchema,
        },
      },
    },
    404: { description: "Not found" },
  },
});
```

**Rules:**

- `tags`, `summary`, `description`, and `responses` are always required.
- `request.params` is required for any route with path params.
- `request.query` is required for any route with query params.
- `request.body` is required for POST/PUT/PATCH routes that accept a body.
- All schemas use Zod with `.openapi()` extensions for OpenAPI metadata.
- Verify at `http://localhost:3000/_docs/scalar` after changes.

## Issue Tracking

**GitHub Issues is where issues live.** File bugs and feature requests there and
reference them from commits and PRs — it is the only tracker every contributor
can see.

Some of us additionally run [beads](https://github.com/gastownhall/beads) (`bd`)
locally, to give coding agents dependency-aware task tracking across sessions. It
is optional and entirely local: `.beads/` is excluded from the repository, so
those issues are never shared through git and nobody needs it to contribute. If
you want it, `bd init --stealth` sets it up without touching any tracked file,
and `bd prime` prints the workflow for your agent.

Because a beads id only resolves on the machine that created it, **do not put one
in committed code, comments, or commit messages.** Give the reason instead — a
dangling `libris-1a2` helps nobody reading this repository.

## Git Forge (GitHub)

This project lives on GitHub at `RazorSiM/libris`. Use the `gh` CLI for all PR and issue operations.

```bash
gh pr create --title "title" --body "description"   # Create PR
gh pr edit <id> --title "new title"                  # Update PR title
gh pr edit <id> --body "new body"                    # Update PR body
gh pr view <id>                                      # View PR
gh pr checks <id> --watch                            # Watch CI status
gh pr comment <id> --body "comment"                  # Comment on PR
gh pr merge <id>                                     # Merge PR
```

## Feature Workflow

When an agent picks up an issue or a feature-sized task, use this workflow by default.

### 1. Start From The Issue

- Read the issue fully before changing code, and claim it so nobody duplicates the work.
- Prefer one branch per issue, or per tightly related fix.
- Branch naming should be short and issue-oriented, for example `fix/settings-tab-query`.

### 2. Work On A Dedicated Branch

```bash
git checkout -b <branch-name>
```

- Do not develop feature work directly on `main`.
- Keep unrelated local changes out of the branch when possible.

### 3. Use A Real Dev Environment

- Start the backend and frontend yourself so you can inspect logs while working.
- Prefer `devenv` for local infrastructure unless there is a clear reason to use Docker.
- If shell tools such as `pnpm` are only available in `devenv`, run validation and git hooks through `devenv shell -- bash -lc '<command>'`.

### 4. Use QA While Building

- Do not rely only on static reasoning.
- Reproduce the problem or exercise the feature in a running app.
- Use browser automation (Playwright or Chrome MCP when available), API checks, logs, filesystem inspection, and direct DB inspection as needed.
- Use `tmp/` for local QA scratch space. Prefer isolated paths like:
  - `tmp/qa-inbox/`
  - `tmp/qa-library/`
  - `tmp/qa-corpus/`
  - `tmp/qa-artifacts/`
- Clean QA-generated `tmp/` contents before and after test runs when appropriate.

### 5. Prefer TDD Or Test-First Repro

- Add or update the smallest test that proves the bug or feature behavior.
- For frontend behavior, prefer Playwright E2E coverage for route, auth, and end-to-end UI flows.
- For backend logic, add or update Vitest coverage close to the changed code.
- If the issue was discovered manually, capture that repro in an automated test whenever practical.

### 6. Run The Full Validation Stack Before Pushing

For code changes, run all of the following unless the task clearly does not affect that layer:

```bash
vp run check
vp run test
vp run -F @libris/e2e e2e
```

- If the running app depends on custom inbox or library paths, make sure the e2e run uses matching `LIBRIS_INBOX_PATH` and `LIBRIS_LIBRARY_PATH` values.
- If a narrower test is useful during development, run it first, but do not skip the broader validation before pushing.

### 7. Keep Docs And Tests In Sync

- Update `docs/` whenever behavior, setup, architecture, or workflows changed.
- Update E2E, integration, or unit tests when behavior changes.
- Add a changeset for every code change before pushing.

### 8. Commit And Push Cleanly

- Stage only the files relevant to the issue.
- If hooks require tools from `devenv`, commit and push through `devenv shell`.
- Do not consider the task complete until the branch is pushed successfully.

### 9. Open A Pull Request

After the branch is pushed:

```bash
gh pr create --title "title" --body "description"
```

PR body should include:

- a short summary
- the GitHub issue it closes, if there is one
- the exact validation commands that passed locally

### 10. Wait For CI Before Hand-Off

- Check the PR status with `gh pr checks <id> --watch` when appropriate.
- If CI fails, fix it on the same branch before considering the work done.

## Session Completion

Run the quality gates, commit locally, and leave the branch ready.

```bash
vp run check
vp run test --no-cache   # --no-cache: a cached run replays a skip as if it passed
git status               # working tree clean, everything committed
```

**Do not push, open a PR, publish an image or push tags unless you are explicitly
asked to.** Those are outward-facing and are the maintainer's call every time.
Finish by reporting what changed, what you validated, and the exact command you
would run next.
