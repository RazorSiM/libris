---
"@libris/api-hono": patch
---

Approving, editing or deleting a book now actually refreshes the OPDS catalogue.

The route cache had two lists that never overlapped. `cachedRoute` was mounted
only on `/opds/*` and `/api/stats`, while every `invalidateRouteCache` call named
`/api/library`, `/api/inbox`, `/api/settings` or `/api/books/{id}/candidates` —
none of which has ever held a cache entry. Both lists read as plausible on their
own, which is why the mismatch survived: every invalidation in the app was a
no-op against a store containing only `routes:/opds/...` keys.

The effect was on the surface real users hit from KOReader or Calibre. Approve a
book, fix a title, delete something — the e-reader refreshing its catalogue kept
being served the pre-change feed, because nothing cleared it and only the 60-120
second TTL ever would.

Mutating routes now invalidate what they actually change. Editing, approving,
deleting or applying metadata to a book clears `/opds` and `/api/stats`; setting
or clearing a manual reading status clears `/api/stats`. Four calls that could
not match anything were removed rather than repointed — a rescan, a metadata
refetch, a re-organize and a settings toggle change nothing that appears in a
cached response, and a call that cannot do anything is worse than no call because
it reads as coverage.

Two guards keep the lists together. `invalidateRouteCache` now only accepts
prefixes under a declared cached root, so naming an uncached path is a type
error; and a test derives the real mount set from the assembled router and fails
if a mount escapes the declared prefixes or a declared prefix has no mount behind
it. The headline test is behavioural rather than string-based: it caches a real
OPDS feed, mutates a book through the real route, and asserts the entry is gone.

Redis-outage behaviour is unchanged — invalidation still never rejects, still
defers failed prefixes to a capped backlog, and every entry still carries a TTL
backstop.
