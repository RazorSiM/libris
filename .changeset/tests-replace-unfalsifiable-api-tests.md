---
"@libris/api-hono": patch
---

Replace the API tests that could not fail, and cover what they were standing in for.

Several tests were asserting things that held regardless of the application
code, while being cited as evidence in issue close-reasons. Each has been
replaced with one that was demonstrated to go red against the broken behaviour
before it was allowed to go green:

- **The last-admin row lock** was "verified" by two concurrent calls against
  PGlite — one embedded backend on one connection, where transactions are queued
  and a `FOR UPDATE` can never contend. It now runs against a real PostgreSQL
  server and asserts that the second transaction blocks until the first commits.
- **The reading-progress, stats and Hardcover sync-log isolation tests**
  inserted both users' rows themselves and selected them straight back, without
  ever calling into the application. They drive the KoSync, stats and sync-log
  endpoints over HTTP now.
- **`/api/reading-status/counts` gains integration coverage for the first
  time.** It cannot run on PGlite at all, which is why its per-user scoping had
  only ever been asserted at the data layer.
- **The atomic Redis increments behind rate limiting had no behavioural test.**
  The only concurrency test in the tree ran against an in-memory Map, which
  cannot lose an update by construction. Both increments are now checked against
  a real Redis, and the in-memory fallback that guards sign-in while Redis is
  down — previously untested — is covered, including that the auth tiers fail
  closed while the general tier fails open.

The suites that need a real PostgreSQL or Redis fail rather than skip in CI, so
a missing service surfaces as a red build instead of silent green. CI's
unit-test job gains both service containers.
