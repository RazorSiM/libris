---
"@libris/api-hono": patch
---

Make the shipped last-admin guard the one the tests exercise (libris-8mx).

`lastAdminMiddleware` carried a `NODE_ENV === "test"` branch that ran the
last-admin check in a transaction it closed _before_ invoking the Better Auth
handler, instead of holding the `SELECT ... FOR UPDATE` row lock across the
write the way production does. It existed only because PGlite — the embedded
test database — is a single backend behind an exclusive mutex, so the real
shape deadlocks there. The consequence was that every HTTP-level test of the
admin subtree exercised a guard that does not ship.

The branch is gone; there is now one code path in every environment. The HTTP
coverage it enabled moved to `tests/admin-subtree-http.postgres.test.ts`, which
drives the same requests through the same `createApp` against a real PostgreSQL
server, where the middleware can hold its lock across Better Auth's write.
