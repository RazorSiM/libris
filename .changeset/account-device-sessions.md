---
"@libris/web": minor
"@libris/api-hono": patch
---

Show where you are signed in, and let you sign a device out.

The Account tab now lists every browser signed in to your account — what it is,
its IP, when it signed in and when the session expires — with the one you are
using marked and sorted first. Each row can be signed out individually, and
there is a "Sign out everywhere else" for the rest. Both ask before acting.

Until now the only revocation available was deleting a whole app password, which
also destroys the credential an e-reader depends on. These are different things
and now have different controls: signing a browser out leaves app passwords
untouched, and the confirmation says so.

**`session.freshAge` is now 0.** `GET /list-sessions` is the one endpoint this
app exposes behind Better Auth's `freshSessionMiddleware`, whose default window
is 24 hours — against a session lifetime of seven days. Left at the default the
device list refuses for six sevenths of a session's life, and the only remedy
available to a user is to sign out and back in, destroying the session they
opened the page to inspect. This costs nothing in revocation strength:
`revoke-session`, `revoke-sessions` and `revoke-other-sessions` all use
`sensitiveSessionMiddleware`, which re-reads the authoritative store and never
consults `freshAge`, and changing a password requires the current password
rather than a recent sign-in.

Revocation goes through the Better Auth API rather than a Drizzle delete. With
`secondaryStorage` configured, `getSession` is served from Redis and never reads
the `sessions` table, so `DELETE FROM sessions` removes a row from the list while
the device keeps working until its TTL lapses — signed out in the UI, signed in
in reality.

Session tokens are never rendered. A token is the value of the cookie that
authenticates that device, so putting one in an attribute or a `data-testid`
would undo the httpOnly cookie for every session at once; rows are keyed by `id`
and an E2E test fails if a token reaches the DOM.

Device labels come from a small User-Agent reader rather than a parsing library:
it only has to be good enough to recognise your own laptop, and an unrecognised
string falls back to the raw value instead of guessing.
