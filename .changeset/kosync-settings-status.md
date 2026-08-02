---
"@libris/api-hono": patch
---

Fix the settings page never showing a configured KoSync credential.

KoSync credentials live in their own `kosync_credentials` table, keyed by user.
`GET /api/credentials/kosync` was updated to read from it, but the aggregate
`GET /api/settings/status` — which is what the settings page actually calls —
still looked them up in `service_credentials`. It therefore reported
`configured: false` with no username for every user, however many times they
saved. The Connections tab rendered a permanently blank KoSync form, and
`kosyncConfigured` was always false.

Both call sites now read the right table.

The same handler assembled its response by indexing the results array
positionally (`results[0]`, `[1]`, `[2]`). With the three services no longer
coming from one query that silently mislabels them the moment the order
changes, so the response is keyed by service name instead.
