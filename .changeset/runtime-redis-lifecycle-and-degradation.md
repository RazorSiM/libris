---
"@libris/api-hono": patch
---

Treat Redis as a cache, not as the authority on who is signed in.

Two defects shared one root cause: the request-path Redis client was never
connected, and every Redis fault was allowed to propagate as if it were a
verdict.

**The client is now connected at creation (libris-59m.14).** It was built with
`lazyConnect: true` and nothing ever called `connect()`, so it sat in ioredis'
"wait" state until the first command — and because `enableOfflineQueue: false`
makes ioredis refuse to buffer while the socket is still undefined, that first
command was rejected outright with "Stream isn't writeable and enableOfflineQueue
options is false", whether or not Redis was reachable. Confirmed in a production
boot: the first request after "Listening on ..." logged `Rate limit check failed,
allowing request`, so the first request(s) after every deploy or restart skipped
rate limiting entirely, and the first authenticated request could 401 with a
spurious sign-out. `enableOfflineQueue: false` and the 250 ms `commandTimeout`
are deliberately unchanged — request-path commands must still fail fast rather
than queue behind a reconnect. The connect is caught, so the server still starts
when Redis is unreachable.

**A Redis blip no longer signs everyone out (libris-59m.15).** Sessions are
written to Postgres as well as Redis, and Better Auth falls through to the
`sessions` row whenever secondary storage answers null — but only for a miss,
never for a throw. Any Redis pause above 250 ms (BGSAVE, AOF rewrite, failover,
restart) therefore turned every logged-in user's request into a 401, and
`/api/auth/*` into a 500, with every session row intact. Secondary-storage reads
(`get`, `getAndDelete`) now degrade to a miss and log at warn; `set` and `delete`
still fail loudly, because a dropped delete is a revocation that silently did not
happen. `increment` falls back to a process-local counter rather than throwing
out of Better Auth's rate limiter, so the auth tier keeps counting instead of
failing open.

Auth failures caused by an unavailable store are now logged distinctly from
rejected credentials, so the next incident is diagnosable from the logs.
