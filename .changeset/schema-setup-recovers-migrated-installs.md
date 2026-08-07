---
"@libris/api-hono": patch
---

Fix a permanent lockout when upgrading an existing install to Better Auth.

The auth cutover migration creates one `users` row per legacy API key but no
password for any of them — a bcrypt key hash cannot become a Better Auth
password hash. `POST /api/setup` gated on "does any user exist", which was now
true, so it answered 409; and the admin endpoints that could have set a password
all require an admin session nobody could obtain. The only way back in was
hand-writing an `accounts` row in psql. A fresh install was never affected.

`GET /api/setup` now reports `required: true` while no credential account exists
anywhere, not merely while no user exists, so the sign-in page offers the
first-run form in exactly that state. `POST /api/setup` ATTACHES the submitted
email and password to a user that already exists — the one already holding that
email, else the oldest admin, else the oldest user promoted to admin — instead of
creating a duplicate person, so books, reading history and app passwords keep
their owner. It closes again with a 409 the moment the first credential exists.

The recovery works on an install that has already applied the cutover migration;
no migration change and no manual SQL is required. The upgrade path is documented
in `docs/deployment.md` under "Upgrading from a pre-Better-Auth install".

`POST /api/setup` responses gain an `adopted` boolean saying which of the two
paths ran.
