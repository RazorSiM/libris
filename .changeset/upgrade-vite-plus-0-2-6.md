---
"@libris/api-hono": patch
"@libris/web": patch
"@libris/docs": patch
---

Upgrade Vite+ from 0.1.24 to 0.2.6 and move the Node toolchain to 26.5.0.

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
