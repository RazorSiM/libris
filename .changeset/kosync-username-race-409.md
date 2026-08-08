---
"@libris/api-hono": patch
---

Give the loser of a concurrent KoSync username claim the same 409 as the
sequential case.

`PUT /api/credentials/kosync` checks the username with a SELECT and then
INSERTs with an `ON CONFLICT` target of the per-user unique index. The username
collision is enforced by a different index, so a claim that arrives between the
SELECT and the INSERT is stopped by Postgres rather than by the handler.

That unique violation used to fall through to the generic credential-write
guard and come back as `Could not save kosync credentials for "x": they
conflict with an existing record` — a 409, but not the same 409, so the message
a user saw depended on whether they lost a race. (It was a 500 until the
`DrizzleQueryError` unwrapping in `shared/db-errors.ts` was repaired; the
unique-violation check had matched nothing since the Drizzle 1.0 upgrade.)

The INSERT now maps its unique violation to the identical
`Username "x" is already taken for kosync` refusal. The `ON CONFLICT` target is
deliberately unchanged: a username collision must refuse, not overwrite the row
that already holds the name.
