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

| Variable              | Purpose                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_HOST`       | Postgres host. The app assembles the connection URL from the `POSTGRES_*` split vars.                                                                                                      |
| `POSTGRES_PORT`       | Postgres port. Optional, defaults to `5432`.                                                                                                                                               |
| `POSTGRES_USER`       | Postgres user.                                                                                                                                                                             |
| `POSTGRES_PASSWORD`   | Postgres password.                                                                                                                                                                         |
| `POSTGRES_DB`         | Postgres database name.                                                                                                                                                                    |
| `REDIS_HOST`          | Redis host. The app assembles the connection URL from the `REDIS_*` split vars.                                                                                                            |
| `REDIS_PORT`          | Redis port. Optional, defaults to `6379`.                                                                                                                                                  |
| `REDIS_USER`          | Redis ACL user. Optional.                                                                                                                                                                  |
| `REDIS_PASSWORD`      | Redis password. Optional.                                                                                                                                                                  |
| `REDIS_TLS`           | Set to `1` for `rediss://` (TLS). Required by most managed Redis providers.                                                                                                                |
| `LIBRIS_INBOX_PATH`   | Writable directory for uploaded book files                                                                                                                                                 |
| `LIBRIS_LIBRARY_PATH` | Writable directory for organized book storage                                                                                                                                              |
| `API_SECRET_KEY`      | Token/cookie encryption secret — **minimum 32 characters**                                                                                                                                 |
| `BETTER_AUTH_SECRET`  | Signs Better Auth session cookies — **minimum 32 characters**. Separate from `API_SECRET_KEY`, with no fallback: the server refuses to start without it. Changing it signs out every user. |

### Optional

| Variable                       | Purpose                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | Port the API server listens on. Default: `3000`.                                                                                                                                                    |
| `COOKIE_DOMAIN`                | Parent domain for auth cookie (e.g., `.example.com`). Leave empty for same-origin.                                                                                                                  |
| `MIGRATIONS_PATH`              | Path to migration files directory. Default: `./migrations`.                                                                                                                                         |
| `TRUST_PROXY_HEADERS`          | Set to `1` behind a trusted reverse proxy so `X-Real-IP` / `X-Forwarded-For` drive auth logging and rate limiting. Default: `0`. See _Reverse Proxy_ below.                                         |
| `LOG_LEVEL`                    | Log level for the production Pino logger only: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `info`. Validated as an enum in the env schema. Does not change the OTel SDK log level. |
| `LIBRIS_COVER_FETCH_ALLOWLIST` | Comma-separated exact HTTP(S) origins allowed to serve covers from private or special-use networks, such as `http://covers.lan:8080`. Redirect destinations need their own entry.                   |

### Rate Limiting

Rate limits are configurable through the validated env schema. The defaults are sized for LAN/VPN deployments. Tighten them if you expose the server publicly.

There are three tiers, each with a request limit and a fixed window in seconds:

- `general` — applies to ordinary API traffic. Defaults to 600 requests per 60 seconds.
- `auth` — applies to authentication endpoints (login, setup). Defaults to 30 requests per 60 seconds.
- `keyCreation` — applies to API-key creation. Defaults to 30 requests per 3600 seconds (1 hour).

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
tier fails open. Existing browser sessions fail closed until Redis recovers;
`/api/health` remains responsive and reports the degraded dependency. Set
`TRUST_PROXY_HEADERS=1` behind a reverse proxy so limits key off the real client
IP. See _Reverse Proxy_ below.

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
    volumes:
      - inbox:/data/inbox
      - library:/data/library
    ports:
      - "3000:3000"

volumes:
  db_data:
  inbox:
  library:
```

## Reverse Proxy

By default, Libris ignores `X-Forwarded-For` and `X-Real-IP` for auth logging and rate limiting and uses the real TCP peer address instead. When running behind a trusted reverse proxy (nginx, Caddy, Traefik), set `TRUST_PROXY_HEADERS=1` and configure the proxy to pass the client IP headers:

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
