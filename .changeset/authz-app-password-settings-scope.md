---
"@libris/api-hono": patch
---

Refuse app passwords on the `/api/settings` surface.

App passwords are scoped out of admin authority, but that scoping only covered
routes declared admin in the route-policy table. `PATCH /api/settings` checks
the role inside its handler and both settings GETs widen their payload for
admins — filesystem paths on `/api/settings`, and on `/api/settings/status` the
queue depths, live database and Redis health, and the arguments of every failed
job. All three resolved to the ordinary authenticated policy, so an admin's app
password reached them with the admin's full authority. That credential is the
one pasted into a KOReader OPDS config, where it sits in plaintext on a device
that leaves the house.

The whole prefix now refuses app-password credentials with 403. Browser sessions
are unaffected, for admins and members alike, and the library, inbox, search and
OPDS surface app passwords exist for is untouched. A new test walks the routers
and fails the build if another handler starts checking the admin role without
declaring its path.

Two existing suites changed with it, because they were asserting the behaviour
this removes: `src/routes/api/settings.test.ts` and `tests/api.test.ts` both
drove the admin diagnostics with a `Bearer` app password, which is exactly the
credential now refused. They authenticate with a browser session instead — the
credential a real admin uses for the settings page — and each gained a case
asserting the 403 and that the refused `PATCH` wrote nothing. `settings.test.ts`
additionally now shares one Better Auth instance between its fixtures and the
app under test, since a session minted by one instance is invisible to another
(secondary storage is per-instance and in memory).
