---
"@libris/web": patch
---

Sign you out and send you to the login page when your session dies.

There was no 401 handler anywhere in the web app. `check()` short-circuits on
`checked` for the rest of a page's life, so once a tab had resolved its session
nothing could tell it the session had gone: the router guard let every
navigation through, and every request 401'd into a "Something went wrong" toast
over a signed-in-looking shell. Every way this branch can invalidate a session
hit it — an admin banning you, another device revoking your session, an admin
setting your password, plain expiry.

Both transports now report a 401 to one place (`lib/session-invalidation.ts`),
and one recovery is installed alongside the router guard: sign out — which
clears the auth store **and** the query cache, so the next person to sign in on
that browser sees none of the previous user's data — then redirect to `/login`
carrying the current route as `?redirect=`. It fires once for a burst of 401s,
does not navigate when already on `/login`, and ignores 401s from `/sign-in`,
`/sign-up`, `/sign-out` and `/get-session`: Better Auth answers a wrong password
with 401 too, and reacting to that would sign out a user who mistyped.

Two specific cases in the Users tab are fixed at the source as well:

- **"Set password" is no longer offered on your own row.** The server deletes
  every session belonging to the target, so pointing it at yourself destroyed
  the cookie in the tab you were using while the toast reported success. "Ban"
  was already gated this way; this now matches, and points you at the Account
  tab, where changing your own password asks for your current one.
- **Demoting yourself now updates the app.** The store kept `isAdmin` true until
  something else refreshed it, so the admin-only tabs carried on rendering and
  their queries started 403ing. The session is re-read after a role change on
  your own row, which drops those tabs.
