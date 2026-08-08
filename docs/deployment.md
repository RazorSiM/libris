# Production Deployment

## Container Image

A single unified image is published to the GitHub Container Registry (GHCR). It contains both the Hono API server and the Vue 3 SPA frontend built with Vite+ (Rolldown-Vite) — Hono serves the static files directly. The image is built on the `node:26.5.0-slim` base.

| Image                     | Port | Description              |
| ------------------------- | ---- | ------------------------ |
| `ghcr.io/razorsim/libris` | 3000 | Hono API + SPA (unified) |

**Tags:**

- `v<api-version>-web<web-version>` — composite tag from both package versions (e.g., `v0.17.1-web2.10.1`). Either version changing produces a new tag.
- `latest` — most recent build

### Building the image

Builds are automatic. Add a changeset with your PR (`pnpm changeset`), and once it merges to main a **"chore: version packages"** PR is opened. Merging _that_ PR bumps the versions, which produces a new composite tag, which triggers the build and push. See [docs/ci-cd.md](ci-cd.md#release-release-yml) for the full flow.

To force a rebuild of the versions currently on main, run the **Release** workflow manually with the `force_publish` input checked.

### Pulling the image

The package is public, so no authentication is needed:

```bash
docker pull ghcr.io/razorsim/libris:latest
```

If the package is private, authenticate first with a token carrying `read:packages`:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin
```

## Deployment Model

The SPA and API are served from the same origin — no CORS configuration needed. The auth cookie works automatically since both are on the same host.

```
books.example.com/         → SPA (served by Hono)
books.example.com/api/*    → Hono API
books.example.com/opds/*   → Hono API (e-reader catalog)
books.example.com/kosync/* → Hono API (reading progress sync)
books.example.com/_docs/*  → Hono API (OpenAPI docs)
```

---

## Environment Variables

### Required

| Variable              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development`, `production`, or `test`. Never inferred: an omitted value must not silently disable a production safeguard. The published image runs `production`, which is what makes `BETTER_AUTH_URL` mandatory below.                                                                                                                                                                                               |
| `POSTGRES_HOST`       | Postgres host. The app assembles the connection URL from the `POSTGRES_*` split vars.                                                                                                                                                                                                                                                                                                                                  |
| `POSTGRES_PORT`       | Postgres port. Optional, defaults to `5432`.                                                                                                                                                                                                                                                                                                                                                                           |
| `POSTGRES_USER`       | Postgres user.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POSTGRES_PASSWORD`   | Postgres password.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POSTGRES_DB`         | Postgres database name.                                                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_HOST`          | Redis host. The app assembles the connection URL from the `REDIS_*` split vars.                                                                                                                                                                                                                                                                                                                                        |
| `REDIS_PORT`          | Redis port. Optional, defaults to `6379`.                                                                                                                                                                                                                                                                                                                                                                              |
| `REDIS_USER`          | Redis ACL user. Optional.                                                                                                                                                                                                                                                                                                                                                                                              |
| `REDIS_PASSWORD`      | Redis password. Optional.                                                                                                                                                                                                                                                                                                                                                                                              |
| `REDIS_TLS`           | Set to `1` for `rediss://` (TLS). Required by most managed Redis providers.                                                                                                                                                                                                                                                                                                                                            |
| `LIBRIS_INBOX_PATH`   | Writable directory for uploaded book files                                                                                                                                                                                                                                                                                                                                                                             |
| `LIBRIS_LIBRARY_PATH` | Writable directory for organized book storage                                                                                                                                                                                                                                                                                                                                                                          |
| `API_SECRET_KEY`      | Third-party token encryption secret. Generate with `openssl rand -hex 32`; placeholders and low-diversity values are rejected.                                                                                                                                                                                                                                                                                         |
| `BETTER_AUTH_SECRET`  | Signs Better Auth session cookies — **minimum 32 characters**. Generate with `openssl rand -base64 32`; placeholders and low-diversity values are rejected. Separate from `API_SECRET_KEY`, with no fallback: the server refuses to start without it. Changing it signs out every user.                                                                                                                                |
| `BETTER_AUTH_URL`     | Public origin users reach, e.g. `https://libris.example.com` — scheme and host only, no path. The production image runs with `NODE_ENV=production`, where this is **required** and the server refuses to boot without it. Better Auth cannot infer an https origin behind a TLS-terminating proxy: it reads the container's plain-http socket address, and every browser sign-in then fails with `403 INVALID_ORIGIN`. |

### Optional

| Variable                         | Purpose                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | Port the API server listens on. Default: `3000`.                                                                                                                                                    |
| `LIBRIS_COOKIE_SECURE`           | Auth cookie `Secure` attribute. Defaults to `1`; set to `0` only when intentionally serving Libris over plain HTTP. Independent of `NODE_ENV`.                                                      |
| `MIGRATIONS_PATH`                | Path to migration files directory. Default: `./migrations`.                                                                                                                                         |
| `TRUST_PROXY_HEADERS`            | Set to `1` behind a reverse proxy only together with `LIBRIS_TRUSTED_PROXIES`. Default: `0`. See _Reverse Proxy_ below.                                                                             |
| `LIBRIS_TRUSTED_PROXIES`         | Exact IPs or narrow CIDRs for reverse proxies allowed to supply client-IP headers. Required when `TRUST_PROXY_HEADERS=1`.                                                                           |
| `LOG_LEVEL`                      | Log level for the production Pino logger only: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `info`. Validated as an enum in the env schema. Does not change the OTel SDK log level. |
| `LIBRIS_COVER_FETCH_ALLOWLIST`   | Comma-separated exact HTTP(S) origins allowed to serve covers from private or special-use networks, such as `http://covers.lan:8080`. Redirect destinations need their own entry.                   |
| `LIBRIS_HTTP_HEADERS_TIMEOUT_MS` | Time allowed to receive complete request headers. Default: `10000`.                                                                                                                                 |
| `LIBRIS_HTTP_REQUEST_TIMEOUT_MS` | Time allowed to receive a complete request body. Default: `30000`.                                                                                                                                  |
| `LIBRIS_HTTP_IDLE_TIMEOUT_MS`    | Maximum inactive time on an HTTP connection. Default: `30000`.                                                                                                                                      |

### Rate Limiting

Rate limits are configurable through the validated env schema. The defaults are sized for LAN/VPN deployments. Tighten them if you expose the server publicly.

There are three tiers, each with a request limit and a window anchored to the client's first request:

- `general` — applies to every path except Better Auth's own `/api/auth/*`, which Better Auth limits itself. `/api/health` is included: it is unauthenticated and costs a database round-trip per call, and the fail-open described below keeps it answerable when Redis is down. `/api/health/live` is included too, but costs nothing to serve — see _Health Endpoints_ below for which one to probe. Defaults to 600 requests per 60 seconds.
- `auth` — applies to `/kosync/users/auth`, the one credential check outside Better Auth's reach, since KOReader speaks its own protocol on its own prefix. It also stacks on top of the two credential-creation routes below. Defaults to 30 requests per 60 seconds.
- `keyCreation` — applies to `POST /api/setup` and `POST /api/app-passwords`. Each costs a password hash, and `/api/setup` is public by necessity — nobody can authenticate on a fresh install — so it carries the strictest budget in the app. Defaults to 30 requests per 3600 seconds (1 hour).

Sign-in, sign-out, password and email changes, the admin plugin and app-password management all sit under `/api/auth/*` and are **not** governed by these variables. Better Auth limits that prefix itself, with much tighter per-endpoint windows than a shared tier can express, and the app's limiter stands aside for it so the two budgets cannot stack. Those counters live in the same Redis as sessions. To change them, edit `rateLimit` in `services/api-hono/src/lib/auth.ts`.

| Variable                                       | Purpose                                                  | Default |
| ---------------------------------------------- | -------------------------------------------------------- | ------- |
| `LIBRIS_RATELIMIT_GENERAL_LIMIT`               | Max requests per window for general API traffic.         | `600`   |
| `LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS`      | General tier window length, in seconds.                  | `60`    |
| `LIBRIS_RATELIMIT_AUTH_LIMIT`                  | Max requests per window for the KoSync credential check. | `30`    |
| `LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS`         | Auth tier window length, in seconds.                     | `60`    |
| `LIBRIS_RATELIMIT_KEY_CREATION_LIMIT`          | Max requests per window for credential creation.         | `30`    |
| `LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS` | Key-creation tier window length, in seconds.             | `3600`  |

Request-path Redis commands have a 250 ms bound. If Redis is unavailable, the
`auth` and `keyCreation` tiers fall back to an in-memory limiter and the `general`
tier fails open. Existing browser sessions keep working: session reads degrade to
a miss and Better Auth falls through to the `sessions` table in Postgres. Cached
route responses degrade to a miss too, and the cache invalidation that follows a
write is deferred rather than raised, so a mutation still returns success — see
_Route cache_ below. `/api/health` remains responsive and reports the degraded
dependency. Set
`TRUST_PROXY_HEADERS=1` with `LIBRIS_TRUSTED_PROXIES` behind a reverse proxy so
limits key off the real client IP. See _Reverse Proxy_ below.

### Route Cache

Exactly two surfaces are cached in Redis, per user, for 60-120 seconds:

- **`/opds/*`** — the catalogue an e-reader browses (root, books, authors,
  genres, series, languages, new arrivals). Covers, downloads and OPDS search
  are not cached.
- **`/api/stats`** — the reading statistics page.

Nothing else is. `/api/library`, `/api/inbox`, `/api/settings` and the book
candidates endpoints answer from Postgres on every request.

Routes that mutate the library clear the prefixes they affect after their
database write commits: editing, approving or deleting a book clears `/opds` and
`/api/stats`; setting or clearing a manual reading status clears `/api/stats`.
Handlers that change nothing a cached response contains — a rescan, a metadata
refetch, a re-organize, a settings toggle — deliberately clear nothing.

Invalidation prefixes are restricted at the type level to paths under a real
`cachedRoute` mount, and a test derives the mounted set from the assembled
router, so the two lists cannot drift apart into a catalogue nothing clears.

Because that write has already committed, a failed invalidation is never
reported to the caller — it would turn a successful mutation into a 500, and a
client that retried would apply the change twice. The failure is compensated
instead: the prefix is remembered and retried by the next invalidation on the
same store and by a 5-second timer, and every entry carries a TTL, so the worst
case is a response up to `maxAge` (at most 120 s) stale. Each deferral logs at
`warn` under the `cache` component.

### OpenTelemetry

The `OTEL_*` variables are standard OpenTelemetry SDK environment variables. They are read directly from `process.env` by the OpenTelemetry `NodeSDK` and are **not** part of the Libris-validated env schema. Only `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME` are referenced by `otel.ts`: setting `OTEL_EXPORTER_OTLP_ENDPOINT` is what activates the SDK (and the SDK does not start when `NODE_ENV=test`), and `OTEL_SERVICE_NAME` defaults to `libris` if unset. The remaining names are interpreted by the SDK itself, not by Libris.

| Variable                      | Purpose                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector URL (e.g., `http://alloy:4318`). Setting this activates the OTel SDK. Checked by `otel.ts`.           |
| `OTEL_SERVICE_NAME`           | Service name in telemetry data. Defaults to `libris` (set by `otel.ts` when unset).                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP protocol: `http/protobuf`, `http/json`, or `grpc`. Interpreted by the OTel SDK; SDK default is `http/protobuf`. |
| `OTEL_TRACES_EXPORTER`        | Trace exporter. SDK default `otlp`. Set to `none` to disable traces.                                                 |
| `OTEL_LOGS_EXPORTER`          | Log exporter. SDK default `otlp`. Set to `none` to disable OTel log export (stdout Pino output is unaffected).       |
| `OTEL_METRICS_EXPORTER`       | Metrics exporter. SDK default `otlp`. Set to `none` to disable metrics.                                              |

## Health Endpoints

There are two, and they answer different questions. Pointing an orchestrator at
the wrong one is the difference between a container that recovers and one that
restart-loops through an outage it cannot fix.

| Endpoint           | Question                                    | Cost                                   | Auth                          | Probe with it for |
| ------------------ | ------------------------------------------- | -------------------------------------- | ----------------------------- | ----------------- |
| `/api/health/live` | Is the process up and serving HTTP?         | None — no database, Redis or event bus | None                          | **Liveness**      |
| `/api/health`      | Can the process reach all its dependencies? | One `SELECT 1` and one Redis `PING`    | Optional (detail when authed) | **Readiness**     |

**Use `/api/health/live` for container liveness probes** (Docker `HEALTHCHECK`,
Kubernetes `livenessProbe`, Compose `healthcheck`). It answers `200 {"status":
"ok", "service": "api"}` the moment the HTTP server is accepting connections and
performs no I/O at all, so probing it every few seconds costs nothing and it
never fails because Postgres or Redis is down. That last property is the point:
a liveness probe on the deep check kills and restarts the container during a
database outage, which cannot help and removes the one process that would have
served cached reads and reported the failure.

**Use `/api/health` for readiness, uptime monitoring and incident triage.** It
verifies the database, Redis and the event bus, answers `503` when any of them
is degraded, and returns per-dependency status with latencies to an
authenticated caller:

```console
$ curl -s localhost:3000/api/health
{"status":"ok","service":"api"}

$ curl -s -H "Authorization: Bearer $APP_PASSWORD" localhost:3000/api/health
{"status":"ok","service":"api","checks":{"database":{"status":"ok","latencyMs":1},"redis":{"status":"ok","latencyMs":1},"eventBus":{"status":"ok"}}}
```

Kubernetes:

```yaml
livenessProbe:
  httpGet: { path: /api/health/live, port: 3000 }
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /api/health, port: 3000 }
  periodSeconds: 30
```

Both paths are in the `general` rate-limit tier (600 requests per 60 seconds by
default, per client IP). At one probe every 10 s that is nowhere near the
budget, but if you point several monitors at the same address through a proxy
without `TRUST_PROXY_HEADERS`, they share one bucket. A rejected probe is
logged: probes that succeed are logged at `debug` (silent under the default
`LOG_LEVEL=info`), and anything else — a `429`, a `503`, a `500` — is logged at
`info` with its status code, so a health check that has started failing is
visible in the access log rather than invisible.

## Volumes

The container needs persistent, writable storage for two paths:

| Mount target                   | Purpose                                     |
| ------------------------------ | ------------------------------------------- |
| Value of `LIBRIS_INBOX_PATH`   | Incoming book files (watched for ingestion) |
| Value of `LIBRIS_LIBRARY_PATH` | Organized book library                      |

## Example Docker Compose

The schema uses Postgres full-text search (`tsvector` GIN indexes) and trigram search on the `books` table. The `pg_trgm` extension is required and must be available in the Postgres image you run. The standard `postgres:17` image ships it. A Postgres build without `pg_trgm` will fail migrations and search.

```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: libris
      POSTGRES_PASSWORD: changeme
      POSTGRES_DB: libris
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U libris"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  libris:
    image: ghcr.io/razorsim/libris:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      POSTGRES_HOST: db
      POSTGRES_PORT: "5432"
      POSTGRES_USER: libris
      POSTGRES_PASSWORD: changeme
      POSTGRES_DB: libris
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      LIBRIS_INBOX_PATH: /data/inbox
      LIBRIS_LIBRARY_PATH: /data/library
      API_SECRET_KEY: # openssl rand -hex 32
      BETTER_AUTH_SECRET: # openssl rand -base64 32
      # The public origin users type, scheme included. Required in production.
      BETTER_AUTH_URL: https://libris.example.com
    volumes:
      - inbox:/data/inbox
      - library:/data/library
    ports:
      - "3000:3000"
    # Liveness, not readiness — see Health Endpoints above. The image is
    # node:*-slim and ships neither curl nor wget, so the probe runs through
    # node itself, which is always there.
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

volumes:
  db_data:
  inbox:
  library:
```

## First Run: Create the Admin Account

There is no seeded account and no default password. The first admin is created through the UI, once, on a running server.

1. Bring the stack up and wait for the API to answer. Migrations apply on boot.
2. Open the origin you set in `BETTER_AUTH_URL` in a browser. Any path redirects to `/login`.
3. Because nobody on this install can sign in yet, `/login` offers the **first-run setup form** instead of the sign-in form. Enter a display name, an email address, and a password of at least 8 characters.
4. Submit. That creates the first user with the `admin` role and signs you in immediately.

The endpoint behind the form (`POST /api/setup`) is public by necessity — there is no account to authenticate with yet — and self-guarding: it answers `409` the moment any account has a password, and the form stops being offered. It is safe to leave mounted.

Everyone else is created by an admin from **Settings → Users**. Self-registration is disabled outright, so `POST /api/auth/sign-up/email` is not exposed.

::: warning Keep one admin credential recoverable
There is no mail transport, so there is no password-reset email. Password recovery is an admin setting someone else's password from **Settings → Users**. If the only admin password is lost, and no admin session survives anywhere, there is no supported way back in short of writing to the database by hand — `POST /api/setup` will not reopen while any credential exists.
:::

If the setup form does not appear on a server you believe is fresh, some account already has a password. Sign in with it.

## Reverse Proxy

When the proxy terminates TLS, `BETTER_AUTH_URL` must name the origin the browser uses:

```env
BETTER_AUTH_URL=https://libris.example.com
```

Libris deliberately does not derive this from `X-Forwarded-Proto` / `X-Forwarded-Host`, because that would make a client-settable header authoritative for the origin that signs and scopes sessions. Without the variable the container's own plain-http origin is the only one Better Auth trusts, and every browser sign-in is refused with `403 INVALID_ORIGIN`; `NODE_ENV=production` therefore refuses to boot until it is set.

By default, Libris ignores `X-Forwarded-For` and `X-Real-IP` for auth logging and rate limiting and uses the real TCP peer address instead. When running behind nginx, Caddy, or Traefik, enable forwarded headers and name the immediate proxy address or narrow container-network allocation explicitly:

```env
TRUST_PROXY_HEADERS=1
LIBRIS_TRUSTED_PROXIES=172.18.0.5/32
```

Do not use an entire LAN or a network that includes clients. Libris first verifies the direct TCP peer against this list, then walks `X-Forwarded-For` from right to left past trusted proxy hops. A client-supplied leftmost value therefore cannot select its own rate-limit bucket. Keep the API origin unreachable except through the proxy as an additional deployment boundary.

Configure the proxy to replace or append the client IP headers:

**nginx:**

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Without this, repeated auth failures from the same client may not be correctly rate-limited.

### WebSocket Upgrade

The SPA receives real-time updates over a single WebSocket at `/api/events`. The reverse proxy must allow the WebSocket upgrade on `/api/*` by forwarding the `Connection` and `Upgrade` headers. Without it, the connection falls back or fails and live UI updates stop working.

**nginx:**

```nginx
location /api/ {
    proxy_pass http://libris:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Caddy and Traefik proxy WebSocket upgrades automatically; no extra configuration is needed for the upgrade itself.

## Database Migrations

Migrations apply automatically on API startup — `runMigrations()` in `services/api-hono/src/bootstrap.ts` runs before the server starts accepting requests. No manual migration step is needed when deploying a new image. The migrations directory is resolved from `MIGRATIONS_PATH` (default `./migrations`, which the Dockerfile copies into the image alongside the bundled server).

## Upgrading to the Better Auth Release

Skip this section for a fresh install; follow [First Run](#first-run-create-the-admin-account) instead.

This release replaces API-key identity with Better Auth accounts. For an existing deployment it is a **hard cutover**, not a rolling upgrade: three new or newly-required environment variables, one variable removed, and every credential in the system invalidated. Everyone is signed out, and every e-reader stops working until it is re-paired. Read the whole section before you start — several steps have no undo.

Take a database backup first. The cutover migration rewrites seven foreign-key columns from `uuid` to `text` and there is no down migration.

### 1. Generate `BETTER_AUTH_SECRET`

New, required, no fallback. The server refuses to start without it.

```bash
openssl rand -base64 32
```

It is deliberately separate from `API_SECRET_KEY` — the two rotate independently, and silently reusing a long-lived secret to sign sessions would be worse than failing to boot. Published placeholders and low-diversity strings are rejected at startup, so it cannot be filled in with something memorable.

### 2. Set `NODE_ENV` explicitly

Also newly required. It used to default to `development`; an omitted value must not be able to disable a production safeguard silently, so it is now validated as one of `development`, `production`, or `test`. For a real deployment this is `production` — which is what makes step 3 mandatory.

### 3. Set `BETTER_AUTH_URL` to the origin your users actually type

```env
BETTER_AUTH_URL=https://libris.example.com
```

Required when `NODE_ENV=production`; the server refuses to boot without it. Scheme and host only — no path, query, credentials or trailing segments, because Better Auth appends its own `/api/auth` base path and a value carrying one produces a subtly wrong cookie and redirect origin rather than an error.

**Behind a TLS-terminating reverse proxy this is the step that decides whether anyone can sign in.** Better Auth does not infer an https origin from `X-Forwarded-Proto`, deliberately: that would make a client-settable header authoritative for the origin that signs and scopes sessions. With no `BETTER_AUTH_URL` it falls back to the origin of the request socket — the container's plain-http address — and because `trustedOrigins` is empty in production, that single derived origin becomes the entire trusted list. Every browser request arriving with `Origin: https://libris.example.com` is then answered `403 INVALID_ORIGIN`. The server starts fine, serves the SPA fine, and refuses every sign-in.

The value must match what the browser sends, including a non-default port. `https://libris.example.com` and `https://libris.example.com:8443` are different origins.

### 4. Delete `COOKIE_DOMAIN`

Removed. The session cookie is now host-only — no `Domain` attribute — so a sibling subdomain cannot set or shadow it for the app origin.

::: warning This one fails silently
`COOKIE_DOMAIN` is no longer read anywhere, and the env schema ignores unknown variables rather than rejecting them. A compose file that still sets it gets **no error at all**. If your deployment relied on it to share the session across subdomains, that no longer works and nothing will tell you why. Serve Libris from a single origin.
:::

### 5. Deploy the new image

Migrations apply on boot, before the server accepts requests. The cutover migration (`20260801115500_auth_cutover`) creates one `users` row per existing API key, so books, reading history and Hardcover tokens keep their owner.

Expect **everyone to be signed out**. The old `books-auth` cookie is gone, along with the `/api/auth/login`, `/logout`, `/session` and `/keys` routes.

### 6. Get back in: the first-run form is the recovery path

The migration deliberately creates **no password** for the users it migrates: the old `api_keys.key_hash` values are bcrypt hashes of API keys, and a Better Auth password hash cannot be derived from one. So immediately after the upgrade users exist but nobody can sign in.

Recovery is self-service and needs **no SQL**:

1. Open Libris in a browser. `/login` shows the **first-run setup form**, because `GET /api/setup` reports `required: true` while no credential exists anywhere on the install — even though users do.
2. Submit your real email, a password, and your display name.

That does **not** create a new person. It attaches the credential to a user that already exists, choosing, in order:

1. the user already holding the email you submitted, if there is one;
2. otherwise the oldest admin — the same row the migration assigned any ownerless books to;
3. otherwise the oldest user, promoted to admin.

The email, display name and `admin` role of that row are updated to what you submitted. Everything owned by it — books, reading progress, Hardcover token — stays attached to the same id.

Once that first credential exists, `POST /api/setup` returns `409` again and the form stops being offered.

::: tip If the form does not appear
Some account already has a password. Sign in with it, then use **Settings → Users** to set anyone else's.
:::

### 7. Give the remaining users real addresses and passwords

Migrated users carry a placeholder `<uuid>@migrated.invalid` email and no password, so they cannot sign in until an admin fixes both from **Settings → Users**. Use **Set password**, and correct the address in the same pass.

### 8. Reissue every e-reader and OPDS credential

Existing API keys are **not** carried over — their hashes are bcrypt, Better Auth uses SHA-256, and one cannot be converted to the other. There is also no OPDS username/password service any more.

Each person mints their own from **Settings → Connections → App Passwords**, one per device, and re-pairs their readers with their account email as the Basic username and the app password as the Basic password. See [Getting Started](/guide/getting-started#pairing-an-e-reader-app-passwords).

Scripted automation changes too: an app password may no longer drive `/api/jobs`, `/api/auth/*`, `/api/app-passwords`, `/api/credentials` or `/api/settings`. Anything hitting those needs a browser session instead. Sending a key as the Basic **username** no longer works either — use `Authorization: Bearer`, `x-api-key`, or Basic with the key as the password.

### 9. Regenerate KoSync credentials

Same reason, and additionally the stored form changed. Each user re-creates theirs from **Settings → Connections → KoSync** and re-enters them on each KOReader device. KoSync passwords now have a 12-character minimum.

### 10. Before deleting anyone, deal with their books

`books.created_by` is now `NOT NULL` with `ON DELETE RESTRICT`, so the database refuses to delete a user who owns books. Removing a user through the admin UI reassigns their books to the acting admin first; a direct `DELETE` against the database will fail partway and leave the account half-removed. Delete users through the app.

Note also that books picked up by the inbox watcher rather than uploaded through the API are owned by the oldest admin, and `created_by` being `NOT NULL` means ingestion fails outright on an install with no admin. Complete step 6 before dropping files into the inbox.

## Rotating Secrets

Neither secret can be rotated without consequences, and neither consequence is announced by the app.

- **`BETTER_AUTH_SECRET`** signs session cookies. Changing it invalidates every session: everybody is signed out and signs in again. Nothing else is lost.
- **`API_SECRET_KEY`** encrypts third-party tokens at rest and peppers the stored KoSync secrets. Changing it has two consequences, neither of which produces an error message:
  - Every stored **Hardcover token** becomes unreadable. The tokens are sealed with this key, not hashed, so each user must reconnect their Hardcover account from **Settings → Connections**.
  - Every **KoSync credential** stops matching, so every paired KOReader device has to be re-paired after its owner regenerates the credential.

  Books, reading history and app passwords are unaffected.

Rotate one at a time, and tell your users first — an operator rotating secrets on a schedule would otherwise silently break every reader.
