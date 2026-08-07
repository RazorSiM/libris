---
"@libris/api-hono": patch
---

Let every user connect their own Hardcover account.

`service_credentials` still carried a global unique index on `(service, username)`
from the days when the table held OPDS and KoSync login identities. Hardcover
stores the literal username "hardcover" for everyone, so the second person in an
install to connect Hardcover hit a unique violation and got a 500 -- silently
contradicting the per-user Hardcover sync the rest of the branch builds. A new
migration drops the index; `(service, user_id)` remains the constraint that
matters.

`PUT /api/credentials/{service}` now answers 409 with an actionable message on
any unique-constraint violation instead of leaking a 500.

Also fixes `isUniqueViolation`/`uniqueViolationMessage` in `shared/db-errors.ts`,
which read `err.code` off the top-level error. Drizzle 1.0 wraps every driver
error in a `DrizzleQueryError`, so the check never matched and the 409 paths in
`/api/books` and `/api/library` (duplicate series index) had been returning 500
since the Drizzle 1.0 upgrade. Both helpers now walk the `cause` chain.
