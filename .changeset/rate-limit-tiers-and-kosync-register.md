---
"@libris/api-hono": patch
---

Hand `/api/auth/*` rate limiting to Better Auth, and remap the app's own tiers
onto the routes that still exist.

The app's limiter matched on `/api/auth/login`, `/api/auth/setup` and
`/api/auth/keys` — all removed in the Better Auth migration, so those tiers had
quietly stopped applying to anything, while Better Auth was separately limiting
the same prefix. It now skips `/api/auth/*` entirely: Better Auth's per-endpoint
windows are much tighter than a shared tier can express (three requests per ten
seconds on sign-in and password change), and stacking two limiters produces a
429 that neither budget accounts for. Those counters live in the same Redis as
sessions, so they survive a restart.

The two remaining tiers are remapped:

- `auth` covers `/kosync/users/auth`, the one credential check outside Better
  Auth's reach — KOReader speaks its own protocol on its own prefix.
- `keyCreation` covers `POST /api/setup` and `POST /api/app-passwords`. Each
  costs a password hash, and `/api/setup` is public by necessity since nobody
  can authenticate on a fresh install.

`LIBRIS_RATELIMIT_AUTH_*` and `LIBRIS_RATELIMIT_KEY_CREATION_*` are kept rather
than retired: both tiers still have real routes behind them, and dropping them
would put the KoSync credential check on the general 600/min budget.

Also fixes `POST /kosync/users/create` returning 500 instead of 409 when called
without a body. It read a JSON body it never used, and an empty POST made that
throw. Registration stays disabled — Libris accounts are admin-created — and the
409 carries a message KOReader shows the user, which a 404 would not.
