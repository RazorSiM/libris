---
"@libris/api-hono": patch
---

Repair the E2E toolchain after the dependency bump

Two independent breakages, both invisible to `check`, `test` and `build`:

**Playwright image drift.** The catalog moved `@playwright/test` 1.60.0 -> 1.62.1
but left the CI container on `mcr.microsoft.com/playwright:v1.60.0-jammy`. The
image ships only the browser build its own version pins, so every E2E job died
at browser launch with `Executable doesn't exist at /ms-playwright/...` before a
single test ran. `docs/ci-cd.md` already required bumping these in lockstep;
nothing enforces it, so the note now spells out the failure mode too. Updated in
`ci.yml` (both E2E jobs), `docker-compose.test.yml` and the docs.

**better-sqlite3 build fallback.** 12.x installed via
`prebuild-install || node-gyp rebuild`, preferring the prebuilt binary. 13.x
drops the install script and ships N-API prebuilds, but keeps its `binding.gyp`
— and pnpm auto-runs `node-gyp rebuild` for an allowed package in that shape. So
every install compiled from source, which needs `make`, which the Playwright
images do not have; `vp run test:e2e:docker` failed during install. It is now
`allowBuilds: false`, and the shipped prebuild is verified working on Node 26.
