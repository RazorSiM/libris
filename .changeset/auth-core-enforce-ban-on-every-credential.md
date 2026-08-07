---
"@libris/api-hono": patch
---

Make banning a user actually revoke their access. The ban was only ever checked when Better Auth created a session, so it held on the browser cookie path and nowhere else: a banned user's app password kept serving `/api/*` and `/opds` indefinitely (app passwords never expire), and their KoSync credentials kept reading and writing progress and kept handing out a userkey they could pair a **new** device with.

The session middleware now refuses a banned user regardless of which credential resolved the session — OPDS clients still get their `WWW-Authenticate` challenge rather than a bare 401 — and the KoSync credential lookup joins `users` and applies the same rule, returning the same indistinguishable 401 a wrong password gets. A ban whose `banExpires` has passed does not block access, matching Better Auth's own semantics.

Banning also **disables** the user's existing app-password rows rather than deleting them. The rows stay visible on the devices page so the user can see what was cut off, and they are deliberately **not** re-enabled on unban — an unban must never silently re-authorize a device that may be the reason for the ban. A user who is unbanned mints a fresh app password and re-pairs.
