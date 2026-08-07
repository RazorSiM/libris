---
"@libris/api-hono": patch
---

Give the CI e2e job the environment the API actually needs to boot.

The job set `E2E_TEST=1` and `LIBRIS_COOKIE_SECURE=0` but neither `NODE_ENV` nor
`TEST_ROUTE_TOKEN`. Since `NODE_ENV` lost its default in `env.ts`, `getEnv()`
threw a `ZodError` before the server bound a port: Playwright's `webServer`
timed out after 60s and all three shards failed without executing a test. Even
past that, every spec that calls a `/__test/*` support route would have died on
the missing token.

The e2e job now sets `NODE_ENV=development` (matching `docker-compose.test.yml`,
and deliberately not `production`, which `bootstrap.ts` refuses alongside
`E2E_TEST=1`) plus a 64-character `TEST_ROUTE_TOKEN`. The throwaway CI secrets
are now `openssl rand -hex 32` values rather than hand-written strings, so
startup validation of placeholder and low-diversity secrets cannot take CI down.
`docker-compose.test.yml` and `.env.test.example` were given the same treatment,
and `.env.test.example` gained the `BETTER_AUTH_SECRET` it was missing.
