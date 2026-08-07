---
"@libris/api-hono": patch
"@libris/web": patch
---

Make the PR gate actually gate the authentication work, and run the production
config in CI at all.

Two structural gaps left this branch's security work unverified. The `e2e` job
runs `--grep @smoke` on pull requests, and `account.spec.ts`,
`isolation.spec.ts`, `first-run-setup.spec.ts`, `websocket-events.spec.ts` and
every `auth.spec.ts` block except `sign-in` carried no tag — so app passwords,
app-password scoping, OPDS Basic auth, the admin user-management walk and the
last-admin 409 first executed *after* merge. Every block that pins an
authentication, authorization, ownership or session invariant is now tagged
`@smoke`; presentation coverage stays untagged so the gate stays fast.

Separately, every E2E run booted the API with `NODE_ENV=development`, because
`bootstrap.ts` refuses `E2E_TEST=1` in production and the suite needs the
`/__test/*` support routes that switch mounts. The development side of every
`NODE_ENV` branch was therefore the only side ever exercised. A new
`e2e-prod-config` job runs `NODE_ENV=production` with no `E2E_TEST`, no
`TEST_ROUTE_TOKEN` and `BETTER_AUTH_URL` deliberately unset — the documented
default behind a TLS-terminating proxy — over first-run setup, sign-in,
sign-out and session revocation, on its own database and Redis.

`docs/testing.md` now states which config branches CI covers and which it does
not, so the gap is readable rather than re-derived.
