---
"@libris/api-hono": patch
---

Stop `GET /api/hardcover/search` spending another user's Hardcover token. The
gate asked "does anyone on this server hold a Hardcover credential" rather than
"does the caller", and the metadata client then resolved the first token in the
table regardless of who was asking — so a user who had never connected Hardcover
could run searches billed to and rate-limited against someone else's account,
while `GET /api/hardcover/status` reported them as disconnected. The search now
requires the caller's own credential (503 otherwise, with no request made to
Hardcover) and passes that token explicitly.

Automatic metadata enrichment now prefers the book owner's own token too, and
still falls back to any token on the install so background enrichment keeps
working for books uploaded by users who have not connected Hardcover.
