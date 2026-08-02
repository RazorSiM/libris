---
"@libris/api-hono": major
---

Scope app passwords so a leaked e-reader credential cannot take over the account.

App passwords resolve into a full session (`enableSessionForAPIKeys`), which is what
lets one `getSession()` call answer for cookies and e-readers alike. The cost was
authority: a credential pasted into a KOReader config — plaintext, on a device that
leaves the house — carried everything its owner could do, and in a household install
the person who sets up OPDS is usually the admin. Upstream flags the option as "not
recommended for production" for exactly this reason.

`authMiddleware` now refuses app-password credentials on admin routes and on the
`APP_PASSWORD_DENIED` prefixes in `shared/route-policy.ts`, before the session is
resolved. Cookie sessions are untouched, and so is everything app passwords exist
for: OPDS browsing and downloads, KoSync, and the ordinary `/api/library`,
`/api/inbox`, `/api/search` surface that Bruno, curl and cron drive.

Measured against the pre-fix build, three surfaces were genuinely reachable with an
admin's app password and are not any more: `/api/jobs` as a full admin,
`/api/app-passwords` (a credential minting and revoking credentials), and
`/api/credentials`. The `/api/auth/` prefix is refused too — Better Auth already
answers 401 there of its own accord, so that part is defence in depth, but it makes
the refusal our invariant rather than an upstream behaviour that a version bump
could change quietly.

Breaking:

- An app password can no longer drive admin routes. Scripted automation that hits
  `/api/jobs` with `Authorization: Bearer <key>` must use a session instead. This is
  deliberate: app passwords are for readers and library scripts, not administration.
- An app password can no longer create, list or revoke app passwords, or write
  service credentials. Manage those while signed in.
