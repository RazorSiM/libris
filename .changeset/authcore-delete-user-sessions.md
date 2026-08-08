---
"@libris/api-hono": patch
---

Clear a deleted account's sessions from Redis, not just from the database.

Better Auth reads sessions from Redis before Postgres, and its own user
deletion only removes the database rows. Removing a user through
**Settings → Users** happened to clear Redis first, so the gap was invisible
there — but any other route to deletion, or an upstream change to that ordering,
would have left the removed account able to keep browsing on an already-open
session until it expired.

Deletion now clears both stores from a database hook, so it holds for every
caller rather than for the one endpoint that remembered.
