---
"@libris/docs": minor
---

Rewrite the documentation for the auth model that actually shipped, and add an
upgrade runbook.

The branch replaced API-key identity with Better Auth accounts and left the auth
sections of the docs describing the old scheme. Everything below was contradicted
by the code it documented.

**Internal docs.** `architecture.md`'s Multi-User Auth section is rewritten around
users, sessions, app passwords and KoSync credentials; its route-policy table now
matches `shared/route-policy.ts` entry for entry, and it gains the
`APP_PASSWORD_DENIED` table, the ban semantics, and the CSRF check. The Auth
Caching subsection is deleted — `clearAuthCaches()` no longer exists, and a
contributor following its documented invariant would have gone looking for a cache
that was removed. `books.created_by` is a `NOT NULL` reference to `users.id`, not a
foreign key to `api_keys.id`. `frontend.md` documents email/password sign-in, the
`/login` route and the redirect-carrying router guard. `contributing.md`,
`environment.md`, `testing.md` and `README.md` are corrected to match.

**User guide.** These pages deploy publicly. `getting-started.md` is rewritten for
the real flow: a first-run admin created with name, email and password; accounts
created by an admin with no self-registration and no reset email; ban semantics,
including that unbanning does **not** re-enable the app passwords banning
disabled; and how to mint an app password to pair a reader. The Settings tab list
is the real eight, with the Account and Users tabs documented and the removed API
Keys tab gone. The OPDS pages drop the deleted OPDS Credentials form in favour of
an account email plus an app password.

**Operator docs.** `deployment.md` gains a "First Run" section (there was no
correct documentation anywhere of how to create the first admin), a ten-step
"Upgrading to the Better Auth Release" runbook covering `BETTER_AUTH_SECRET`,
`NODE_ENV`, `BETTER_AUTH_URL` behind a TLS-terminating proxy, the silently-ignored
`COOKIE_DOMAIN`, the mass sign-out, self-service recovery through the first-run
form, reissuing every device credential, and the book-reassignment constraint on
deleting a user; and a "Rotating Secrets" section, because neither secret can be
rotated without consequences and neither consequence is announced by the app.

**Agent guide.** `AGENTS.md` no longer recommends `drizzle-kit generate
--ignore-conflicts`. That flag suppresses the single-leaf snapshot check, which is
exactly the check that catches two migrations generated from the same parent, and
it hid a branched chain on this branch until the snapshots had to be repaired.
