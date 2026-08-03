---
"@libris/api-hono": major
---

Split identity from credential: add a `users` table and repoint every owned row at it.

`api_keys` used to be the user table, with seven columns referencing it. Revoking a
key cascade-deleted the owner's reading history, one person could not hold two
credentials, and `is_admin` was a property of the key rather than of the person.

The cutover migration creates one user per existing api key, repoints all seven
columns from `api_keys.id` to `users.id` (uuid to text), and reshapes `api_keys`
into the Better Auth apiKey plugin's model. `books.created_by` is now `NOT NULL`,
and reading history cascades from the user rather than from a credential.

A follow-up migration renames the six repointed columns from `api_key_id` to
`user_id`, along with their indexes and constraints, so the schema stops
describing a user id as an api key id.

App passwords now arrive three ways — `x-api-key`, `Authorization: Bearer` and
Basic's password field — so OPDS readers, Bruno, curl and cron all resolve to the
same session through one credential. KoSync moves to its own `kosync_credentials`
table keyed by a sha256 of the value KOReader puts on the wire.

`authMiddleware` is rewritten around a single `auth.api.getSession()` call, which
resolves cookie sessions and app passwords alike — the five-branch policy switch,
its five-minute in-memory cache, and the `clearAuthCaches()` invariant are gone,
so revoking a credential now takes effect immediately.

The legacy `/api/auth/setup`, `/login`, `/logout`, `/session` and `/keys` routes are
removed. Sign-in, sign-out and session are Better Auth's; first-run bootstrap moves
to `POST /api/setup`, which creates the first admin only while no user exists.

Breaking:

- `NODE_ENV` is now required instead of silently defaulting to `development`.
  Test-support routes are mounted only for `NODE_ENV=test` or `E2E_TEST=1`, and
  require a separate 32+ character `TEST_ROUTE_TOKEN` even then.

- Self-registration is now disabled outright (`disableSignUp`). Previously enabling
  email/password auth would have exposed `POST /api/auth/sign-up/email` publicly.
  All accounts are admin-created.
- `POST /api/auth/setup` is now `POST /api/setup` and takes an email, password and
  name instead of a key label.
- `POST /api/auth/login` and the `books-auth` cookie are gone. Clients sign in
  through Better Auth and everyone is logged out on deploy.

- Existing API keys are **not** carried over. Their hashes are bcrypt and Better
  Auth uses SHA-256, so every OPDS and e-reader credential must be reissued.
- Migrated users get a placeholder `@migrated.invalid` email and no password. An
  admin sets a real address and password before they can sign in.
- Deleting a user who owns books is now refused by the database; reassign their
  books first.
- Books found in the inbox directory by the watcher, rather than uploaded through
  the API, are now owned by the oldest admin. `books.created_by` is `NOT NULL`, so
  ingestion fails outright on an install with no admin.
- KoSync credentials must be regenerated: the stored value changed from
  `bcrypt(md5(password))` to `sha256` of the wire value, and one cannot be derived
  from the other. Only the md5 digest KOReader actually sends authenticates now —
  the raw plaintext used to work as well, which meant two valid secrets per
  account.
- Sending an API key as the HTTP Basic **username** no longer works. Use
  `Authorization: Bearer`, `x-api-key`, or Basic with the key as the password.
- `/api/auth/keys` is replaced by `/api/app-passwords`, and the model behind it
  inverts: managing credentials is no longer admin-only, because a credential is
  no longer a person. Everyone manages their own; creating accounts is separate.
  Revoking a credential you do not own returns 404 rather than 403, so ids cannot
  be probed for existence.
- `PUT /api/credentials/opds` is gone — OPDS clients use app passwords.
- OPDS rows in `service_credentials` are deleted; the table itself stays for the
  Hardcover token.
