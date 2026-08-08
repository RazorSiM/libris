---
"@libris/api-hono": patch
---

Fund the scheduled Hardcover install-wide phase from an admin's quota instead of
an arbitrary user's. Each nightly sync runs ISBN matching and the edition
page-count backfill once over the whole catalog, and the worker paid for them
with `validUsers[0].token` — whichever connected user the credential query
happened to return first. An ordinary member's third-party API quota was
therefore spent on install-wide work, and which member it was could change
between runs as credentials were added or removed.

The phase now runs on the token of the oldest admin who has connected Hardcover,
picked deterministically so it does not drift. When no admin has connected
Hardcover the phase is skipped with a log line explaining why, rather than
falling back to another user's token. Per-book metadata enrichment is unchanged:
it still prefers the book owner's token with an install-wide fallback, because
there it has an obvious person to bill.
