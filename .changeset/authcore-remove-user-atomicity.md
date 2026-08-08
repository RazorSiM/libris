---
"@libris/api-hono": patch
---

Document and pin why removing a user reassigns their books in a separate
transaction from the last-admin guard.

No behaviour change: an admin removal that is refused still leaves the library
exactly as it found it. What changes is that the reasoning is now enforced by
tests — the "obvious" repair of doing both writes in one transaction is proved,
against a real PostgreSQL, to break the removal outright, so a future
refactor towards it fails the suite instead of shipping.
