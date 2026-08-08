---
"@libris/api-hono": patch
---

Let background jobs invalidate the route cache (libris-021).

Only HTTP handlers could clear the cached OPDS feeds and `/api/stats`, and the
writes that matter most happen after the request has returned. Approving a book
answered and invalidated immediately; the organize job then wrote the book's
cover and storage paths minutes later for a large file, with nothing left to
clear the entry — so a book that had just been approved sat in an e-reader's
catalogue with no cover for up to two minutes. Refreshing metadata on a book
already in the library had the same gap, and a reading position pushed from
KOReader never updated the cached statistics it feeds.

Workers now reach the cache through a process-wide store rather than a request,
which keeps working unchanged once they move into their own process. Cache
failures still degrade instead of failing the job: a Redis outage defers the
invalidation for retry and the entry expires on its TTL regardless.
