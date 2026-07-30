---
"@libris/api-hono": patch
"@libris/web": patch
"@libris/docs": patch
---

Make the unit-test tasks cacheable again.

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
