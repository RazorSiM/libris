---
"@libris/api-hono": patch
---

A Redis outage no longer fails every mutating request (libris-hs5).

`invalidateRouteCache` propagated its KV error. Every route that edits a book,
approves an upload or changes a setting calls it _after_ the Postgres write has
committed, so while Redis was unavailable those routes answered 500 on work they
had already done successfully — and a client that retried the "failed" request
applied the change twice. This is the same policy libris-59m.15 established for
Better Auth's secondary storage: Redis is a cache in front of durable Postgres,
and a Redis fault must not become the request's verdict.

Invalidation is a different case from that module's `set`/`delete`, which
deliberately still throw: a caller told "the delete failed" can retry the
revocation, but a caller told "the invalidation failed" has nothing left to roll
back. Swallowing alone would be wrong too — a cache entry written before the
outage would survive it and serve stale data. So the failure is compensated
instead of raised:

- **Deferred retry.** A prefix whose invalidation failed is remembered per cache
  store and retried by the next `invalidateRouteCache` call on that store, and
  by an unreferenced 5-second timer so recovery does not depend on further
  traffic. The backlog is capped at 256 prefixes (they are not a fixed set —
  `/api/books/{id}/candidates` is per book) and the oldest are evicted first.
- **TTL backstop.** Every cached response is written with `ttl: maxAge`, 60-120
  seconds across the mounted routes, so even a backlog lost to a restart or to
  the cap expires on its own.

Worst-case staleness is therefore the entry's remaining TTL — at most 120
seconds — and in practice the retry clears it first. Nothing new is cached
during the outage either: the cache middleware already treats a read error as a
miss and its writes fail alongside everything else, so the exposure is limited to
entries written before the outage began. Each deferral logs at warn with the
prefixes involved.
