---
"@libris/web": patch
---

Changing your password no longer signs you out of the browser you changed it in.

With "sign out everywhere else" ticked, the account panel vanished the moment the
change went through: the device list emptied, the password form was left disabled
with the new password still in it, and the next navigation landed on the login
page. The change itself had succeeded — the browser was signed out of an account
it was still perfectly signed in to.

Better Auth implements "revoke other sessions" as revoke-**all**-then-re-issue-mine:
`POST /change-password` deletes every session row for the account, the caller's
included, and only then creates a replacement and rotates the cookie. Deleting
the caller's row fires the database hook that closes that tab's live event socket
with `4401` — the same close a ban sends — and the SPA had just been taught to
treat a `4401` as terminal and sign the user out.

The server cannot tell the two apart: at hook time a delete is a delete, and only
the client knows which cookie it is holding. Neither can the client find out by
asking, because the close frame is written before the response that carries the
replacement cookie, so any session probe fired from the close handler asks with
the dead cookie.

So the tab now says when it is deliberately replacing its own credential. A
`4401` that arrives during a password change waits for the new cookie and is then
handled as a re-scope — refresh the session, re-dial once — instead of a
sign-out. Everything else is unchanged: a ban, a sign-out, an admin-set password
or a revocation from another device still close the socket and take the tab to
the login page, and a password change that the server refuses rotates nothing, so
a `4401` around it still signs out.
