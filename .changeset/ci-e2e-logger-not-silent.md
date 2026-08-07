---
"@libris/api-hono": patch
---

Stop silencing the API log under `E2E_TEST=1`.

`lib/logger.ts` treated `E2E_TEST=1` the same as `NODE_ENV=test` and installed a
disabled transport, so the whole API process emitted nothing in exactly the two
modes CI and Docker use: no access log, no "Auth failure from &lt;ip&gt;", no worker
output, no `job:failed` detail. Every auth-failure diagnostic was invisible in
the only environment that exercises it, and a red E2E shard showed a bare 401
with no server-side explanation.

Only `NODE_ENV=test` is silent now. `E2E_TEST=1` takes the Pino transport, which
is machine-readable and — the original reason for the change — still keeps
`better-sqlite3` and the pretty-terminal transport out of the E2E container. The
CI e2e job tees that output to a file and uploads it as `e2e-api-log-<shard>`
when a shard fails.
