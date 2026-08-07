---
"@libris/api-hono": patch
"@libris/web": patch
---

Fix the settings page never showing a configured KoSync credential.

KoSync credentials live in their own `kosync_credentials` table, keyed by user.
`GET /api/credentials/kosync` and the `credentials.kosync` entry of
`GET /api/settings/status` were updated to read from it, but the `settings`
block of that same `/status` response still looked KoSync up in
`service_credentials` — a table the KoSync migration emptied and no writer has
touched since. `settings.kosyncConfigured` was therefore pinned to `false`, and
the Connections tab bound to exactly that field, so the red "KoSync is not
configured" alert survived every save.

`settings.kosyncConfigured` is now **removed** from `GET /api/settings/status`
rather than repaired: it was a second, independently-computed copy of
`credentials.kosync.configured` in the same payload, and a second copy is a
second chance to desync. `SettingsKosync.vue` reads `credentials.kosync`.
`GET /api/settings` keeps its own `kosyncConfigured` field, which already read
the right table.

The alert no longer claims KoSync credentials can be supplied "via environment
variables on the server" — no `KOSYNC_*` variable exists in the env schema.

The same handler assembled its response by indexing the results array
positionally (`results[0]`, `[1]`, `[2]`). With the three services no longer
coming from one query that silently mislabels them the moment the order
changes, so the response is keyed by service name instead.
