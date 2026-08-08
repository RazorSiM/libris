---
"@libris/api-hono": patch
---

`GET /api/settings` now documents which of its fields are admin-only.

The endpoint returns the server's library and inbox filesystem paths to
administrators and withholds them from everyone else. That decision lived as an
inline `...(isAdmin(c) ? {…} : {})` spread in the middle of the handler's return
statement, while the OpenAPI schema declared both paths as plain optional
strings with nothing said about who receives them. To anyone reading the API
documentation that meant "the server might not have these configured" rather
than "you are not allowed to see these" — and to anyone auditing which endpoints
disclose host paths, the branch was easy to miss entirely.

The admin-only half is now a named schema whose fields state their authority in
the document, produced by a single `adminOnlySettings()` projection. The four
admin-only sections of `GET /api/settings/status` — health, queues, failed jobs
and settings, already nullable for non-admins — now say in the document why they
are null.

Behaviour is unchanged: the same callers receive the same fields as before. This
is the contract catching up with the code.
