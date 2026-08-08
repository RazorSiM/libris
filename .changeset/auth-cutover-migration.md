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
to `POST /api/setup`, which establishes the first admin credential and is available
only while nobody on the install can sign in with a password yet.

Breaking:

- **`BETTER_AUTH_SECRET` is now required, with no fallback.** It signs Better Auth
  session cookies, and there is deliberately no fallback to `API_SECRET_KEY`: the
  two rotate independently, and silently reusing a long-lived secret for session
  signing is worse than failing to boot. An unmodified upgrade therefore
  crash-loops at startup until it is set. Generate one with
  `openssl rand -base64 32`; published placeholders and low-diversity values are
  rejected. Changing it later signs out every user.

- **`BETTER_AUTH_URL` is now required when `NODE_ENV=production`**, and must be a
  bare http(s) origin — scheme and host only, no path, query or credentials. It
  names the origin users actually reach. Better Auth does not infer an https
  origin behind a TLS-terminating proxy, so without it the container's own
  plain-http socket origin becomes the entire trusted-origin list and every
  browser sign-in is answered `403 INVALID_ORIGIN`. It is validated at boot, so
  a missing value is a startup error rather than a server that runs happily and
  refuses every login.

- `NODE_ENV` is now required instead of silently defaulting to `development`. An
  omitted value must not be able to disable a production safeguard. Test-support
  routes are mounted only for `NODE_ENV=test` or `E2E_TEST=1`, and require a
  separate 32+ character `TEST_ROUTE_TOKEN` even then.

- Self-registration is now disabled outright (`disableSignUp`). Previously enabling
  email/password auth would have exposed `POST /api/auth/sign-up/email` publicly.
  All accounts are admin-created.
- `POST /api/auth/setup` is now `POST /api/setup` and takes an email, password and
  name instead of a key label.
- `POST /api/auth/login` and the `books-auth` cookie are gone. Clients sign in
  through Better Auth and everyone is logged out on deploy.

- Existing API keys are **not** carried over. Their hashes are bcrypt and Better
  Auth uses SHA-256, so every OPDS and e-reader credential must be reissued.
- Migrated users get a placeholder `@migrated.invalid` email and no password, so
  immediately after the upgrade nobody can sign in yet. Recovery is the first-run
  setup form, which the sign-in page offers automatically in that state: it
  attaches your email and password to an EXISTING user rather than creating a new
  one, and closes again once that first credential exists. From there an admin
  sets the remaining users' addresses and passwords from Settings → Users. See
  "Upgrading from a pre-Better-Auth install" in `docs/deployment.md`.
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
- KoSync passwords must contain at least 12 characters.
- Reading progress in the bulk library sync feed is now scoped to the signed-in
  user instead of combining every account's activity.
- Request-path Redis operations are bounded and application rate-limit counters
  increment atomically under concurrency.
