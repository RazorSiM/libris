---
"@libris/api-hono": patch
---

Scope the dashboard's inbox count to the caller. `GET /api/dashboard` counted
every user's inbox and review books, so the home page told a user how many
unapproved uploads other people had pending while the sidebar badge and the
/inbox page — both owner-scoped — showed none of them. Non-admins now get their
own count, matching `GET /api/inbox/count`; admins still get the install-wide
one. The shared organized library stats and "recently added" are unchanged.
